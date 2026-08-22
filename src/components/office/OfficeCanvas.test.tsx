import { describe, it, expect, vi, beforeEach, afterEach } from '../../bun-test.js';
import { render, fireEvent } from '@testing-library/react';
import { centerCamera, MAX_ZOOM, MIN_ZOOM, TILE_SIZE } from '@/lib/office';
import { buildOfficeScene, type OfficeAgent, type OfficeScene } from './agents-to-characters.js';
import { FALLBACK_VIEWPORT, OfficeCanvas, fitZoom } from './OfficeCanvas';

/**
 * What happy-dom actually gives us: `HTMLCanvasElement.getContext('2d')` returns **null**, and
 * every element measures 0x0. So there is no pixel output to assert on and no layout — these
 * tests cover the parts that are real here: mounting, the frame loop and its teardown, the
 * no-2D-context bail-out, and the click → grid-cell → character chain (whose camera the
 * component derives from `FALLBACK_VIEWPORT`, since the host element measures zero).
 */

function agent(overrides: Partial<OfficeAgent> = {}): OfficeAgent {
  return {
    key: 'task-1:0',
    taskId: 'task-1',
    windowIndex: 0,
    taskTitle: 'Fix the flaky poller test',
    agentName: 'Agent 1',
    activity: 'active',
    ...overrides,
  };
}

/** rAF that records its callbacks and never runs them, so a frame is always pending. */
function pendingRaf() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextHandle = 0;
  const raf = vi.fn((cb: FrameRequestCallback) => {
    nextHandle += 1;
    callbacks.set(nextHandle, cb);
    return nextHandle;
  });
  const caf = vi.fn((handle: number) => callbacks.delete(handle));
  vi.stubGlobal('requestAnimationFrame', raf);
  vi.stubGlobal('cancelAnimationFrame', caf);
  return { raf, caf, callbacks };
}

/** rAF that runs its callback immediately, so a mount paints (or tries to) synchronously. */
function immediateRaf() {
  let handle = 0;
  const raf = vi.fn((cb: FrameRequestCallback) => {
    handle += 1;
    cb(handle);
    return handle;
  });
  const caf = vi.fn();
  vi.stubGlobal('requestAnimationFrame', raf);
  vi.stubGlobal('cancelAnimationFrame', caf);
  return { raf, caf };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fitZoom', () => {
  it.each([
    ['fits a tall map into a short viewport', 22, 23, 960, 600, 1],
    ['takes the smaller of the two axes', 20, 10, 700, 400, 2],
    ['clamps to MAX_ZOOM on a huge viewport', 10, 10, 4000, 4000, MAX_ZOOM],
    ['clamps to MIN_ZOOM when the map does not fit', 22, 23, 100, 100, MIN_ZOOM],
    ['clamps to MIN_ZOOM for a zero-sized viewport', 22, 23, 0, 0, MIN_ZOOM],
    ['clamps to MIN_ZOOM for an empty map', 0, 0, 800, 600, MIN_ZOOM],
  ])('%s', (_label, cols, rows, width, height, expected) => {
    expect(fitZoom(cols, rows, width, height)).toBe(expected);
  });

  it('is always a whole number, so 16px tiles land on whole pixels', () => {
    for (const width of [321, 640, 999, 1737]) {
      expect(Number.isInteger(fitZoom(22, 23, width, 600))).toBe(true);
    }
  });
});

describe('OfficeCanvas', () => {
  let scene: OfficeScene;

  beforeEach(() => {
    scene = buildOfficeScene([agent({ key: 'a:0' }), agent({ key: 'b:0', activity: 'waiting' })]);
  });

  it('mounts and exposes the canvas to assistive tech', () => {
    immediateRaf();
    const { getByRole, getByTestId } = render(<OfficeCanvas scene={scene} label="Office view" />);
    expect(getByTestId('office-canvas')).toBeInTheDocument();
    expect(getByRole('img', { name: 'Office view' })).toBeInTheDocument();
  });

  it('cancels the pending animation frame on unmount', () => {
    const { raf, caf } = pendingRaf();
    const { unmount } = render(<OfficeCanvas scene={scene} />);

    expect(raf).toHaveBeenCalledTimes(1);
    const handle = raf.mock.results[0].value;

    unmount();
    expect(caf).toHaveBeenCalledWith(handle);
  });

  it('does not leave a frame queued after unmount', () => {
    const { raf, caf, callbacks } = pendingRaf();
    const { unmount } = render(<OfficeCanvas scene={scene} />);
    unmount();
    expect(callbacks.size).toBe(0);
    expect(caf).toHaveBeenCalledTimes(raf.mock.calls.length);
  });

  it('survives a canvas with no 2D context and stops asking for frames', () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    const { raf } = immediateRaf();

    const { getByTestId } = render(<OfficeCanvas scene={scene} />);

    // The draw path really ran — it got as far as asking for a context and found none.
    expect(getContext).toHaveBeenCalledWith('2d');
    expect(getContext.mock.results[0].value).toBeNull();
    expect(getByTestId('office-canvas')).toBeInTheDocument();
    // One frame, and no follow-up: nothing is animating, so the loop stops.
    expect(raf).toHaveBeenCalledTimes(1);
  });

  it('asks for no new frame when a re-render changes nothing', () => {
    const { raf } = immediateRaf();
    const { rerender } = render(<OfficeCanvas scene={scene} selectedCharacterId={null} />);
    expect(raf).toHaveBeenCalledTimes(1);

    rerender(<OfficeCanvas scene={scene} selectedCharacterId={null} />);
    expect(raf).toHaveBeenCalledTimes(1);
  });

  it('asks for a frame when a new scene arrives', () => {
    const { raf } = immediateRaf();
    const { rerender } = render(<OfficeCanvas scene={scene} />);
    expect(raf).toHaveBeenCalledTimes(1);

    rerender(<OfficeCanvas scene={buildOfficeScene([agent({ activity: 'waiting' })])} />);
    expect(raf).toHaveBeenCalledTimes(2);
  });

  it('asks for a frame when the selection changes', () => {
    const { raf } = immediateRaf();
    const { rerender } = render(<OfficeCanvas scene={scene} selectedCharacterId={null} />);
    expect(raf).toHaveBeenCalledTimes(1);

    rerender(<OfficeCanvas scene={scene} selectedCharacterId="a:0" />);
    expect(raf).toHaveBeenCalledTimes(2);
  });

  describe('clicking', () => {
    /**
     * Reproduces the camera the component computed. The host element measures 0x0 in happy-dom,
     * so the component fell back to FALLBACK_VIEWPORT; the canvas rect is all zeros, so click
     * coordinates are viewport coordinates.
     */
    function clickPointFor(characterId: string) {
      const character = scene.characters.find((c) => c.id === characterId)!;
      const { width, height } = FALLBACK_VIEWPORT;
      const zoom = fitZoom(scene.layout.cols, scene.layout.rows, width, height);
      const camera = centerCamera(scene.layout.cols, scene.layout.rows, width, height, zoom);
      return {
        clientX: character.x * zoom - camera.x + (TILE_SIZE * zoom) / 2,
        clientY: character.y * zoom - camera.y + (TILE_SIZE * zoom) / 2,
      };
    }

    it('reports the character under the pointer', () => {
      immediateRaf();
      const onSelectCharacter = vi.fn();
      const { getByTestId } = render(
        <OfficeCanvas scene={scene} onSelectCharacter={onSelectCharacter} />,
      );

      fireEvent.click(getByTestId('office-canvas'), clickPointFor('b:0'));
      expect(onSelectCharacter).toHaveBeenCalledWith('b:0');
    });

    it('reports null for a click on empty floor', () => {
      immediateRaf();
      const onSelectCharacter = vi.fn();
      const { getByTestId } = render(
        <OfficeCanvas scene={scene} onSelectCharacter={onSelectCharacter} />,
      );

      fireEvent.click(getByTestId('office-canvas'), { clientX: 0, clientY: 0 });
      expect(onSelectCharacter).toHaveBeenCalledWith(null);
    });

    it('is inert without a handler', () => {
      immediateRaf();
      const { getByTestId } = render(<OfficeCanvas scene={scene} />);
      expect(() =>
        fireEvent.click(getByTestId('office-canvas'), clickPointFor('a:0')),
      ).not.toThrow();
    });
  });
});
