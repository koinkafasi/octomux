# Motor katmanı (M1)

Tarih: 2026-08-21. Program bağlamı: `spec/agentspace-program.md`.
Bu doküman `spec/harness-abstraction.md`'yi genişletir, yerine geçmez.

## 1. Neden

octomux bugün iki harness destekliyor (`claude-code`, `cursor`). Hedef 12.
Mevcut `Harness` arayüzü bunun için tasarlanmış ama tamamlanmamış.

### Doğrulanmış mevcut durum

- `server/harnesses/types.ts` — dört üye **bağlanmamış**; kendi yorumları
  "Currently unwired — no call site reads this member yet" diyor:
  `buildPromptDelivery`, `attachMcp`, `sendMessage`, `detectActivity`.
  Bu davranışlar bugün `task-engine/launch.ts` içinde hardcoded.
- `buildLaunchCommand(opts): string` — shell **string** döndürüyor, argv değil.
  `validateFlagString()` yasak metakarakterleri elemeye çalışıyor
  (savunma katmanı olarak kalacak) ama 12 motoru string birleştirmeyle
  çağırmak enjeksiyon yüzeyidir.
- `server/harnesses/registry.ts` — `registerHarness` / `freezeCoreHarnesses` /
  `getHarness` / `listHarnesses` çalışıyor, `CORE_HARNESS_IDS = ['claude-code','cursor']`.
  Bu altyapı korunur.
- Şemada `owner_id` yok (S1.5 bunu ekler).

## 2. Tasarım

### 2.1 Tek arayüz, genişletilmiş

`Harness` kalır. Overstory'nin `AgentRuntime`'ında çözülmüş üyelerle genişler:

```ts
interface Harness {
  id: string;
  displayName: string;
  sessionIdMode: 'orchestrator-assigned' | 'harness-issued';
  instructionFile: string; // CLAUDE.md | AGENTS.md | ...

  buildLaunchArgv(opts: HarnessLaunchOpts): string[]; // string → argv
  buildResumeArgv(opts: HarnessResumeOpts): string[];
  buildContinueArgv(opts: HarnessResumeOpts): string[] | null;

  detectReady(paneContent: string): ReadyState; // Overstory; bugünkü unwired detectActivity
  deployConfig(worktreePath, overlay, hooks): Promise<void>; // bugünkü installHooks
  uninstallHooks(dirPath: string): Promise<void>; // mevcut, korunur
  parseTranscript(path: string): Promise<TranscriptSummary | null>; // YENİ

  events(handle: RunHandle): AsyncIterable<AgentEvent>; // YENİ, bkz. 2.3

  capabilities: HarnessCapabilities; // bkz. 2.4
  resolveFlags(settings): string; // mevcut
  validateSettings(blob: unknown): Record<string, unknown>;
  validateAgentName(name: string): string;
}
```

`buildPromptDelivery` / `attachMcp` / `sendMessage` üyeleri kaldırılır — işlevleri
sırasıyla `buildLaunchArgv`, preset'in MCP bloğu (2.2) ve `events()`'in karşı
yönü olan `send()` tarafından karşılanır.

### 2.2 İki kademeli motor tanımı

| Kademe                | Yer                               | Ne zaman             |
| --------------------- | --------------------------------- | -------------------- |
| 1 — deklaratif preset | `server/harnesses/presets/*.json` | Çoğu motor           |
| 2 — kod adaptörü      | `server/harnesses/<id>.ts`        | Preset'e sığmayanlar |

octomux'ta bu idiom zaten var: `kinds/*.json` presetleri + `registerWorkflow()`
kod handler'ları. Aynı desen.

Preset alanları — Gas Town `AgentPresetInfo`'dan uyarlandı:

```jsonc
{
  "id": "gemini",
  "displayName": "Gemini CLI",
  "command": "gemini",
  "args": ["--yolo"],
  "env": {},
  "processNames": ["gemini", "node"], // tmux pane_current_command ile canlılık
  "resumeFlag": "--resume",
  "resumeStyle": "flag", // "flag" | "subcommand"
  "continueFlag": null,
  "instructionFile": "AGENTS.md",
  "readyPromptPrefix": "> ",
  "readyDelayMs": 1500,
  "emitsPermissionWarning": false,
  "escapeCancelsRequest": true, // Escape üretimi iptal ediyorsa nudge'da gönderme
  "hasTurnBoundaryDrain": false,
  "hooks": { "provider": null },
  "mcp": { "inject": "settings_file", "settingsPath": ".gemini/settings.json", "transport": "sse" },
  "acp": { "mode": "flag", "args": ["--acp"] },
  "capabilities": { "contextUsage": true, "sessionFork": false },
}
```

`mcp.inject` taksonomisi agentchattr'dan: `settings_file` | `env` | `flag` |
`proxy_flag`. `acp` bloğu Gas Town `ACPConfig`'ten: `native` | `subcommand` | `flag`.

`escapeCancelsRequest` bir tuzağı kapatır: bazı motorlarda Escape tuşu üretimi
iptal eder, o yüzden mesaj enjeksiyonunda gönderilmemelidir.

### 2.3 İç olay sözleşmesi = ACP sözlüğü

Tüm motorlar aynı olay akışını üretir. Sözlük ACP'den alınır
(vibe-kanban'ın `AcpEvent` enum'unun karşılığı):

```ts
type AgentEvent =
  | { t: 'session_start'; sessionId: string }
  | { t: 'message'; content: ContentBlock }
  | { t: 'thought'; content: ContentBlock }
  | { t: 'tool_call'; call: ToolCall }
  | { t: 'tool_update'; update: ToolCallUpdate }
  | { t: 'plan'; plan: Plan }
  | { t: 'request_permission'; req: PermissionRequest }
  | { t: 'usage'; inputTokens: number; outputTokens: number; model: string }
  | { t: 'error'; message: string }
  | { t: 'done'; reason: string };
```

- **ACP konuşan motorlar** bunu doğrudan üretir (`@agentclientprotocol/sdk` v1.4.0).
- **Konuşmayanlar** adaptörde çevirir (vibe-kanban'ın `normalize_logs` modeli).

Kazanç: izin istekleri artık Claude Code'a özel hook'lara bağlı değil.
`request_permission` her motordan gelir ve mevcut `permission_prompts` tablosuna
tek yoldan yazılır. `usage` olayı M2'nin token/maliyet kartını besler.

### 2.4 Yetenek bayrakları

vibe-kanban'ın `BaseAgentCapability`'sinden:

```ts
interface HarnessCapabilities {
  contextUsage: boolean; // motor token kullanımını kendi bildiriyor mu
  sessionFork: boolean; // --fork-session var mı
  setupHelper: boolean; // önce login/kurulum gerekiyor mu
  acp: boolean; // ACP konuşuyor mu
}
```

UI bunlara bakıp özellikleri gizler; M2'nin maliyet kartı `contextUsage`'a bakar.

### 2.5 S1.5 şeması

Her tabloya `owner_id TEXT NOT NULL DEFAULT 'local'` eklenir. Tek kullanıcıda
sabit `'local'` değeri taşır. Migration forward-only, mevcut satırlar
`'local'` alır. Amaç: M6'da çok kiracılılığa geçerken hiçbir tablo yeniden
yazılmaz. Bugün hiçbir sorgu bu sütuna göre filtrelemez.

## 3. Motor listesi

Bayraklar Overstory `src/runtimes/*.ts` kaynağından çıkarıldı. `gemini` ve
`claude` yerelde kurulu olduğu için **gerçek binary'nin `--help` çıktısıyla
doğrulandı**; diğerleri kaynak-doğrulaması (canlı test M1'in çıkış kriteri değil).

| Motor       | Kademe  | Etkileşimli komut                                      | Talimat dosyası                   | Doğrulama   |
| ----------- | ------- | ------------------------------------------------------ | --------------------------------- | ----------- |
| claude-code | 2 (kod) | `claude --model X --permission-mode bypassPermissions` | `CLAUDE.md`                       | ✅ binary   |
| gemini      | 1 + ACP | `gemini -m X --approval-mode yolo`                     | `AGENTS.md`                       | ✅ binary   |
| codex       | 2 (kod) | `codex --full-auto --model X` (+ `--add-dir`)          | `AGENTS.md`                       | kaynak      |
| cursor      | 1       | `agent --model X --yolo`                               | `.cursor/rules/*.md`              | kaynak      |
| copilot     | 1       | `copilot --model X --allow-all-tools`                  | `.github/copilot-instructions.md` | kaynak      |
| opencode    | 1 + ACP | `opencode --model X` (ACP: `opencode acp`)             | `AGENTS.md`                       | kaynak      |
| qwen        | 1 + ACP | Gemini CLI çatallaması, aynı bayraklar                 | `AGENTS.md`                       | türetilmiş  |
| amp         | 1       | `amp --model X --yes`                                  | `.amp/AGENT.md`                   | kaynak      |
| droid       | 1       | `--autonomy skip-permissions-unsafe`                   | doğrulanacak                      | vibe-kanban |
| goose       | 1       | `goose --model X --instructions <file>`                | `.goosehints`                     | kaynak      |
| aider       | 1       | `aider --yes-always --no-auto-commits --model X`       | `CONVENTIONS.md`                  | kaynak      |
| pi          | 1       | `pi --model X --append-system-prompt …`                | `AGENTS.md`                       | kaynak      |

### Doğrulanmış ACP kanıtı

`gemini --help` çıktısı: `--acp    Starts the agent in ACP mode  [boolean]`.
Bu, spec §2.2'deki `acp.mode = "flag"` kademesinin kurulu bir binary üzerinde
doğrulanmış halidir. `opencode acp` (`subcommand`) ve `claude-code-acp`
(`native`) Gas Town ve vibe-kanban kaynaklarından; canlı doğrulanmadı.

### Gönderilen preset'ler (uygulama durumu)

`server/harnesses/presets/` altında 9 tier-1 preset var ve hepsi
`loadEnginePresets()`'ten temiz geçiyor: `gemini`, `copilot`, `opencode`,
`amp`, `goose`, `aider`, `pi`, `droid`, `qwen`.

- **Binary'ye gömülme çözüldü.** `scripts/bundle-assets.mjs`'in `TREES`
  listesine `server/harnesses/presets` eklendi (iç içe yol; `walk()` her
  dosyayı `root`'a göre anahtarlıyor, `enginePresetsDir()` de
  `<assetRoot()>/server/harnesses/presets` çözüyor — ikisi örtüşüyor).
  Doğrulandı: `assets.generated.json` artık preset dosyalarını içeriyor.
- **`claude-code` ve `codex` preset almadı** — tier 2, kod adaptörü.
  `cursor` da şimdilik kod adaptörü olarak kalıyor (mevcut `cursor.ts`
  korunuyor); preset'e indirgenmesi ayrı bir adım.
- **Canlı doğrulanmamış:** `droid` ve `qwen`. `droid`'in bayrakları yalnızca
  vibe-kanban'ın `default_profiles.json`'ından türetildi (argv kanıtı yok);
  `qwen` gemini-cli çatallaması varsayımıyla gemini bayraklarını kullanıyor.
  Bu iki motor kurulup teyit edilene kadar şüpheli sayılmalı.
- **Düzeltilen hata:** `gemini.json` başta `["--yolo"]` taşıyordu (bu spec'in
  ilk taslağından kopyalandı). Gerçek binary'de bare `--yolo` yok; doğrusu
  `--approval-mode yolo`.

### Çelişki notu

vibe-kanban'ın `default_profiles.json`'ı gemini için `"yolo": true` diyor,
Overstory `--approval-mode yolo` üretiyor. Gerçek binary'de **bare `--yolo`
bayrağı yok** — `--approval-mode` `default|auto_edit|yolo|plan` alıyor.
Overstory doğru; vibe-kanban'ın alanı bir soyutlama, birebir bayrak değil.
Preset'lerde ham bayrak yazılır, soyutlama değil.

### argv kararının gerekçesi (kaynaktan kanıt)

Overstory'nin her adaptörü shell **string** kuruyor ve tırnakları elle
kaçırıyor: `.replace(/'/g, "'\\''")`. Birkaçı daha da ileri gidip çift
tırnak içinde komut ikamesi kullanıyor — `amp`, `codex` ve `pi`'de
`"$(cat '<dosya>')"`. Bu tam olarak §2.1'in `buildLaunchArgv(): string[]`
ile kapattığı yüzeydir. Port ederken bu escaping mantığı **taşınmaz**,
argv dizisine çevrilir.

## 4. Test

- Preset yükleyici: ajv şema doğrulaması, her preset dosyası için table-driven test.
- Her motor için `buildLaunchArgv` / `buildResumeArgv` altın-çıktı testi
  (argv dizisi olarak, string değil).
- `detectReady`: gerçek pane çıktısı fixture'ları.
- Olay normalizasyonu: motor başına kaydedilmiş stdout fixture'ı → `AgentEvent[]`.
- ACP: `@agentclientprotocol/sdk`'a karşı sahte bir ajan süreciyle round-trip.
- Mevcut `server/harnesses/*.test.ts` regresyon olarak korunur.

Yerelde yalnızca `claude` ve `gemini` kurulu. Diğer motorlar fixture ile test
edilir; canlı doğrulama kurulum gerektirir ve M1'in çıkış kriteri değildir.

## 5. Teslim adımları

1. S1.5 şema migration'ı (`owner_id`).
2. `AgentEvent` tipleri + `normalize` yardımcıları.
3. Preset şeması + yükleyici + ajv doğrulaması.
4. `Harness` arayüzünü genişlet; `claude-code` ve `cursor`'ı ona taşı (argv dahil).
5. ACP adaptörü (`@agentclientprotocol/sdk`).
6. Kalan motorların preset'leri.
7. `task-engine/launch.ts`'teki hardcoded yolları arayüze bağla.

Adım 4 tek riskli adım: mevcut iki harness'ın davranışı korunmalı, bunu var olan
test paketi güvenceye alır.

## 6. ACP: iki yürütme modeli — ve neden M1'de bağlanmıyor

ACP istemcisi (`server/harnesses/acp/{argv,client,session,normalize}.ts`)
yazıldı ve test edildi. **Ama görev motoruna bağlanmadı, ve bu bilinçli.**

Sebep mimari: octomux'un tüm görev yolu ajanı bir **tmux penceresinin başlangıç
süreci olarak** başlatır (`task-engine/launch.ts` → `tmuxWindowSubstrate.launchWindow`).
İnsan `tmux attach` ile izleyebilsin diye. ACP ise stdio üzerinden JSON-RPC
konuşan, programatik olarak sürülen bir alt süreçtir — bir tmux panelinde
çalıştırılırsa terminale JSON-RPC kusar, kimsenin işine yaramaz.

İkisi **farklı yürütme modelleri**, aynı şeyin iki argv'si değil.

### Bağlamak için gereken (M2 işi)

| Engel                   | Bugünkü hali                                              | Gereken                                          |
| ----------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| `SpawnOptions.command`  | `string` — tam shell komut satırı                         | argv varyantı; `buildAcpArgv()` argv üretiyor    |
| `ProcessSubstrate.kind` | `'pty' \| 'tmux'`                                         | üçüncü bir kind, ya da substrate dışı bir koşucu |
| Görev motoru            | her ajanın attach edilebilir bir paneli olduğunu varsayar | ACP ajanının paneli yok                          |
| Arayüz                  | terminal çıktısı render eder                              | `AgentEvent` akışı render etmeli                 |

### M1'de kasten yapılmayan şey

`Harness`'a kullanılmayan bir `acpArgv()` üyesi **eklenmedi**. Bu tam olarak
§1'de şikâyet edilen anti-deseni tekrarlardı — mevcut arayüz zaten dört yıl
"Currently unwired — no call site reads this member yet" yorumuyla yaşadı.
Çağıran yok ise üye de yok.

Preset'lerdeki `acp` bloğu ve `capabilities.acp` bayrağı **veri olarak doğru ve
test edilmiş**; `buildAcpArgv()` onları argv'ye çeviriyor. Eksik olan tek şey,
o argv'yi çalıştıracak koşucu.

### Doğrulanmış zemin

`gemini --help` → `--acp  Starts the agent in ACP mode  [boolean]`. Yani
`acp.mode = "flag"` kademesi kurulu bir binary üzerinde doğrulandı.
`opencode acp` (`subcommand`) ve `claude-code-acp` (`native`) Gas Town ve
vibe-kanban kaynaklarından; canlı doğrulanmadı.
