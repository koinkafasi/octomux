# AgentSpace-denk ürün programı

Tarih: 2026-08-21. Durum: kapsam ve fazlar onaylandı, M1 tasarımı `spec/engine-layer.md`.

## Amaç

octomux tabanı üzerine, Muratify AgentSpace'in yetenek yüzeyini açık kaynak
referanslardan yeniden kurmak. Web tabanlı geliştirilir, Electron masaüstü
kabuğu en sona bırakılır. Önce tek makinede çalışır, sonra sunucuya taşınır.

**AgentSpace'in kendi kodu kopyalanmaz.** Kapalı kaynak ticari bir üründür;
yalnızca yetenek envanteri çıkarmak için AppImage'ı incelendi (`~/.agentdesk`,
v0.2.39, iç adı `agentdesk-shell`). Hiçbir açık kaynak repodan fork değildir —
sıfırdan yazılmış, ~190 kendi modülü var.

## Alınmış kararlar

| Karar                | Seçim                                                                          |
| -------------------- | ------------------------------------------------------------------------------ |
| Taban                | octomux (parallel-code veya sıfırdan değil)                                    |
| Motor katmanı        | Overstory'nin `AgentRuntime` katmanını port et, ACP'yi içine kademe olarak koy |
| Veri konumlandırması | Bulut-öncelikli, Supabase merkezli                                             |
| Şema stratejisi      | **S1.5** — S2-hazır şema (her tabloda `owner_id`), tek kiracı çalıştır         |
| Electron             | E1 (kabuk + derlenmiş bun binary'si alt süreç olarak), M6'ya ertelendi         |
| Arayüz               | Web önce; masaüstü sonra                                                       |

### S1.5 gerekçesi

Ajanlar yerel süreç olarak, yerel git worktree'lerinde, tmux içinde çalışır.
Paylaşılan bir sunucuda bu bir güvenlik sınırı problemidir — kullanıcı başına
container/VM gerekir. O iş M6'ya bırakıldı, ama **şema bugünden hazırlanır**:
her tabloya `owner_id` eklenir ve tek kullanıcıda sabit bir değer taşır.
Böylece sunucuya geçişte hiçbir tablo yeniden yazılmaz.

Doğrulandı: bugün şemada `user_id` / `tenant_id` / `org_id` / `owner_id` yok.
`server/remote-auth.ts` uzak modu biliyor (`OCTOMUX_BIND` loopback dışı →
paylaşılan token) ama bu **tek kimlik** modelidir, çok kiracılılık değil.

## Sürümler

| Sürüm               | Kapsam                                                             | Çıktı                           |
| ------------------- | ------------------------------------------------------------------ | ------------------------------- |
| **M1 — Çekirdek**   | S1.5 şeması + motor katmanı, 2 → 12 motor                          | Web'de 12 motorlu octomux       |
| **M2 — Görünürlük** | Pixel-art ofis UI, token/maliyet kartı, limit tespiti, hesap devri | AgentSpace'in ana ekranı        |
| **M3 — Zeka**       | Hindsight hafıza, Supabase pgvector senkron, skills alt sistemi    | RAG hafıza                      |
| **M4 — Erişim**     | Mobil web, Tailscale gateway, ses (STT/TTS/Türkçe morfoloji)       | Telefondan sesle yönetim        |
| **M5 — Otonomi**    | Merge queue, watchdog, tarayıcı otomasyonu                         | Kendi kendine merge eden sistem |
| **M6 — Dağıtım**    | S2 container izolasyonu, Electron kabuğu                           | SaaS + masaüstü                 |

Her sürüm kendi spec → plan → uygulama döngüsünü alır ve tek başına
kullanılabilir bir çıktı verir.

## Referans haritası

Hepsi kullanıcının makinesinde kurulu ve incelendi.

| Kaynak                                                          | Lisans       | Hangi sürüm | Ne için                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------- | ------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Overstory](https://github.com/jayminwest/overstory)            | MIT, arşivli | M1          | `AgentRuntime` arayüzü + `src/runtimes/` altında 11 adaptör, testleriyle. Bun+TS+SQLite+tmux — octomux ile aynı stack                                                                                                                                                                                                                     |
| [Gas Town](https://github.com/gastownhall/gastown)              | MIT          | M1, M2, M5  | `AgentPresetInfo` preset şeması, `ACPConfig`, `internal/quota/` hesap devri, `usage_limit.go` limit regex'leri, Refinery merge queue, Witness/Deacon watchdog                                                                                                                                                                             |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban)           | Apache-2.0   | M1, M2      | `normalize_logs.rs` motor başına log normalizasyonu, `AcpEvent` olay sözlüğü, `BaseAgentCapability`                                                                                                                                                                                                                                       |
| [agentchattr](https://github.com/bcurts/agentchattr)            | MIT          | M1          | MCP enjeksiyon taksonomisi (`settings_file`/`env`/`flag`/`proxy_flag`)                                                                                                                                                                                                                                                                    |
| [OpenHands](https://github.com/OpenHands/OpenHands)             | MIT          | M2, M4      | Maliyet/bütçe React bileşenleri, responsive mobil kalıplar                                                                                                                                                                                                                                                                                |
| [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents) | —            | M2          | Pixel-art ofis, agent-agnostic `HookProvider`                                                                                                                                                                                                                                                                                             |
| [agora-lab](https://github.com/LiXin97/agora-lab)               | Apache-2.0   | **M2**      | ⭐ `packages/web/src/engine/` — React 19 + ham Canvas 2D pixel motoru (tileMap, sprites, characters, camera, lighting, particles, render-policy), 12 testle. Bağımlılığı sadece `react`+`react-dom`; octomux'un Vite+React 19+Tailwind stack'ine birebir oturuyor. **Bayat** (2026-04-18'den beri push yok) ama motor kendi içinde kapalı |
| [parallel-code](https://github.com/johannesjo/parallel-code)    | MIT          | M4          | QR + Tailscale mobil izleme                                                                                                                                                                                                                                                                                                               |
| [Hindsight](https://github.com/vectorize-io/hindsight)          | MIT          | M3          | Postgres+pgvector hafıza. `@vectorize-io/hindsight-client`, `@vectorize-io/hindsight-all`                                                                                                                                                                                                                                                 |
| [Grove](https://github.com/bearlike/Grove)                      | MIT          | M3, M4, M6  | octomux'un kardeşi (Python/Textual TUI, worktree+tmux). Bizde henüz olmayanları **çalışır halde** gönderiyor — aşağıya bak                                                                                                                                                                                                                |

Apache-2.0 olan tek kaynak Vibe Kanban: ondan kod alınırsa o dosyalarda Apache
bildirimi korunur. Diğerleri MIT, octomux da MIT.

### Grove — neden ayrıca önemli

`bearlike/Grove` v0.0.7 aynı çekirdek fikri paylaşıyor (ajan başına git worktree +
tmux oturumu) ama bizim M3–M6 listemizdeki birkaç şeyi şimdiden gönderiyor:

| Grove komutu                                                          | Bizdeki karşılığı                                                                                                                            |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pause` / `resume` — worktree'yi sil, dalı koru, resume yeniden kurar | `spec/session-hibernation.md` tasarım aşamasında; Grove'da çalışıyor                                                                         |
| `phase` — scoping/planning/implementing/verifying/delivering/done     | **Yeni eksen.** `runtime_state` (tmux/süreç) ve `workflow_status` (pano sütunu) ikisine de dik: ajanın _kendi_ ilerlemesi hakkında söylediği |
| `fleet` — host'taki tüm workspace'ler tek JSON okumada                | Bizde dağınık                                                                                                                                |
| `code` / `shell` — devcontainer'a attach                              | M6 container izolasyonu                                                                                                                      |
| `auth` — pairing request onay/red, aktif oturum yönetimi              | M4 cihaz eşleştirme                                                                                                                          |
| `usage` — geçmiş ajan kullanımı + telemetri export                    | M3 token/maliyet                                                                                                                             |
| `container.egress.mode = 'allowlist'` + iptables netfilter            | **Planımızda yok.** Ajanın dışarı çıkışını allowlist'le kısıtlamak                                                                           |

Worktree kökü `${repo}/.worktrees` — octomux'unkiyle **aynı dizin**. Çakışma
kontrol edildi: octomux'un `reconcile.ts`'i DB satırı güdümlüdür, `.worktrees`'i
tarayıp bilinmeyenleri silmez; dal önekleri (`grove/` vs `agents/`) ve tmux
önekleri (`grove-` vs `octomux-agent-`) de ayrı. Yan yana çalışabilirler.

## Genişletilmiş referanslar (GitHub `worktree-manager` topic taraması, 2026-08-22)

49 repo tarandı. Beşi gerçek değer taşıyor; ~34'ü sade worktree kolaylık aracı
(bizde zaten daha ilerisi var) ve listelenmedi.

| Kaynak                                             | Lisans       | Sürüm                | Ne için                                                                                                                                                                                                                             |
| -------------------------------------------------- | ------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [h5i](https://github.com/h5i-dev/h5i)              | Apache-2.0   | **M5, M6**           | ⭐ Tek başına üç boşluk kapatıyor. Üç kademeli izolasyon (OS kontrolleri / rootless container / **microVM**), **izole tarayıcı** (Chromium veya saf-Rust `h5i-browser-light`), ve git-destekli ajan forumu (thread/claim/review/oy) |
| [claudette](https://github.com/utensils/claudette) | MIT          | M2, M4, M6           | ⭐ Tauri 2 + Rust + React/TS + **Bun** — bize en yakın izin verici lisanslı proje. Checkpoint/workspace çatallama, mDNS ile LAN keşfi, **sandbox'lanmış Lua eklentileri**, cihaz-üstü ses, GitLab SCM sağlayıcısı                   |
| [nerve](https://github.com/mascah/nerve)           | MIT          | M1                   | Paralel worktree'lerde **port çakışması** — deterministik offset aritmetiği (`base_port + project_offset + N`), dotfile klonlama, flock korumalı kayıt defteri                                                                      |
| [greentree](https://github.com/Reachpad/greentree) | Apache-2.0   | Loop motoru          | Çalışma ağacını içerik-adresleyip **doğrulama sonucunu tree hash'iyle önbelleğe alır**; geçmemiş ağaçtan commit'i reddeder                                                                                                          |
| [Pane](https://github.com/dcouple/Pane)            | **AGPL-3.0** | M4 (sadece fikir)    | ⚠️ Masaüstü + **mobil tarayıcı** istemcisi, motor-agnostik, TypeScript                                                                                                                                                              |
| [Axel](https://github.com/scarce/axel)             | **YOK**      | M3/M6 (sadece fikir) | ⚠️ **Automerge CRDT + Supabase** senkron katmanı — bulut senkronu için tek referansımız. Ayrıca birleşik gelen-kutusu kart arayüzü (iPhone varyantı dahil)                                                                          |

### Lisans kısıtları — mühendislik kısıtıdır, dipnot değil

- **Apache-2.0 / MIT** (h5i, claudette, nerve, greentree, Overstory, Gas Town,
  agentchattr, OpenHands, parallel-code, Grove, Hindsight): kod alınabilir,
  atıf korunur.
- **Apache-2.0 → MIT projeye**: alınan dosyalarda Apache bildirimi korunur
  (Vibe Kanban için de geçerli).
- **AGPL-3.0** (Pane): §13 ağ maddesi, değiştirilmiş sürümü ağ hizmeti olarak
  çalıştıran herkesi kaynağı sunmaya zorlar. **Bulut-öncelikli kararımızla
  bağdaşmaz** — Pane'den kod alınmaz, yalnızca özellik/UX referansı.
- **Lisanssız** (Axel, hawt, `txtx/axel` ve topic'teki birkaç küçük repo):
  tüm haklar saklı. Okuyup yaklaşımı anlamak serbest, dosya taşımak değil.

### Bu taramanın açtığı yeni iş kalemleri

Planda olmayan, ama referansı bulunduğu için artık somut:

| Fikir                                                                                                     | Kaynak           | Neden önemli                                                                              |
| --------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| Denetim izi: `patch.diff` + `report.md` (ne çalıştı / ne reddedildi / ne redakte edildi) + `receipt.json` | h5i `box export` | Otonom ajanın ne yaptığının incelenebilir kaydı                                           |
| Sandbox içindeki dev sunucuyu uçtan uca şifreli P2P veya demo linkiyle paylaşma                           | h5i `box share`  | Ürün özelliği; planda yoktu                                                               |
| Checkpoint + workspace çatallama (oturumu geri sar, alternatif keşfet)                                    | claudette        | Ralph loop'larıyla doğrudan eşleşir                                                       |
| Eklenti sandbox'ı                                                                                         | claudette (Lua)  | Bizim eklentilerimiz süreç-içi JS: DB handle'ı, tüm kimlikler, `process.env`, sandbox yok |
| Worktree başına çakışmayan port tahsisi                                                                   | nerve            | Kullanıcı iki worktree'de dev sunucu kaldırırsa bugün çarpışır                            |
| Verify sonucunu tree hash'iyle önbelleğe alma                                                             | greentree        | Loop motoru bugün her iterasyonda baştan koşuyor                                          |

### Kalan boşluk

**Çok kiracılılık / auth / faturalama (M6)** için hâlâ referansımız yok.

### M2 tasarım dersi — pixel canvas birincil yüzey olmayabilir

agora-lab pixel görünümü **birincil arayüzden indirdi**. Kendi README'sinden:

> Lab View is a **low-motion monitoring surface** — agents occupy fixed positions
> and update their state as the lab progresses, but continuous movement animation
> is not the normal experience. **The canvas is no longer the primary control surface.**

Varsayılan deneyimleri artık "Analyst Workbench": solda ajan listesi, ortada
kanban, sağda mesajlar, altta karar günlüğü + sistem sağlığı. Pixel görünüm
ikincil bir sekme.

Bu, AgentSpace'in konumlandırmasıyla çelişiyor — orada pixel ofis ürünün
kendisi. Kanıt AgentSpace'i yanlışlamıyor (kitleler farklı olabilir), ama M2
tasarlanırken bilinmeli: **pixel yüzey kontrol arayüzü olarak değil, izleme
arayüzü olarak daha iyi çalışıyor olabilir.** M2'nin varsayılanı bir
dashboard, pixel ofis ikinci sekme olarak planlanmalı; tersi değil.

`render-policy.ts`'teki `characterSignature()` deseni (karakter durumu
değişmediyse yeniden çizme) bu düşük-hareket yaklaşımının performans
karşılığıdır ve doğrudan alınabilir.

## Boşluk araştırması (2026-08-22)

### 1. Bulut senkron / CRDT — kapandı, Axel'den çok daha iyisiyle

Axel (lisanssız, Swift) bu satırdaki tek referansımızdı. Artık gerek yok:

| Kaynak                                                                  | ★     | Lisans         | Not                                                                                                                                |
| ----------------------------------------------------------------------- | ----- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [electric-sql/electric](https://github.com/electric-sql/electric)       | 10.3k | **Apache-2.0** | TS, aktif. Sloganı artık _"The agent platform built on sync"_ — ajanlara yeniden konumlanmışlar. Postgres → istemci senkron motoru |
| [rocicorp/mono](https://github.com/rocicorp/mono) (Zero)                | 3.4k  | **Apache-2.0** | TS, aktif. Sorgu-güdümlü senkron + yerel önbellek                                                                                  |
| [automerge/automerge-repo](https://github.com/automerge/automerge-repo) | 704   | **MIT**        | TS. Axel'in kullandığı Automerge altyapısının kendisi — **Axel lisanssızdı, bu değil**                                             |

Genel `automerge+postgres` / `yjs+postgres` aramaları sadece 0-yıldızlı oyuncak
projeler döndürdü; ciddi oyuncuları isimle aramak gerekti. `aspen-cloud/triplit`
(3.1k) da var ama **AGPL-3.0** — bulut-öncelikli kararımızla bağdaşmaz.

**Karar önerisi:** ElectricSQL. Apache-2.0, Postgres-yerli, en aktif, ve
ajan iş yüküne açıkça yönelmiş.

### 2. Çok kiracılılık — bu bir repo problemi değil

Aranan boilerplate'lerin hepsi alakasız çıktı (restoran sipariş, LMS,
link-in-bio). Doğru çerçeve şu: çok kiracılılık kopyalanacak bir kod değil,
**Postgres Row-Level Security disiplini**. Riskli olan kısım da kodu yazmak
değil, bir politikayı unutmak — o da kiracılar arası veri sızıntısı demek.

İki küçük MIT aracı tam bu riski hedefliyor:

| Kaynak                                                  | ★   | Lisans | Ne yapar                                                                                      |
| ------------------------------------------------------- | --- | ------ | --------------------------------------------------------------------------------------------- |
| [pgrls/pgrls](https://github.com/pgrls/pgrls)           | 26  | MIT    | Postgres RLS statik analizörü — kiracı ve kullanıcı-kapsamlı satırlar için **67 lint kuralı** |
| [matte97p/rlsgrid](https://github.com/matte97p/rlsgrid) | 7   | MIT    | Şema-güdümlü RLS test matrisi üreteci ve **kiracılar arası fuzzer** (Postgres/**Supabase**)   |

S1.5 → S2 geçişinde (`owner_id` sütunları zaten yerinde) bu ikisi CI kapısı
olarak koşmalı. Referans mimari için `aws-samples/aws-saas-factory-postgresql-rls`
(MIT-0) okunabilir, ama Java ve 2024.

### 3. AgentSpace'ten öte: ölçüm

**Tez:** 12 motor gönderiyoruz. AgentSpace 8 gönderiyor ve birini seçmene izin
veriyor. Ne AgentSpace, ne Grove, ne Overstory, ne vibe-kanban şu soruyu
cevaplıyor:

> **Benim depomda, bu tür bir görevde hangi motor/model gerçekten daha iyi?**

octomux'ta bu cevabın **iki parçası zaten var**:

1. `loop-start-group --n <candidates>` — N rakip adayı fan-out et
2. `--verify '<cmd>'` — nesnel geç/kal

Eksik parçalar, hepsinin referansı elimizde:

| Parça                                                                              | Kaynak                                                                                                                                                                                                                   | Lisans     |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| Aday yörüngelerini LLM-as-a-Verifier ile sırala (Kwok ve ark. turnuva algoritması) | [omp-best-of](https://github.com/wolfiesch/omp-best-of)                                                                                                                                                                  | MIT        |
| Ajanın kendi ilerleme fazı (scoping→…→done)                                        | Grove `phase`                                                                                                                                                                                                            | MIT        |
| Çalıştırma makbuzu: ne çalıştı / ne reddedildi / ne redakte edildi                 | h5i `box export`                                                                                                                                                                                                         | Apache-2.0 |
| Aday başına token + maliyet                                                        | gastown `quota/`, OpenHands UI                                                                                                                                                                                           | MIT        |
| Görev seti metodolojisi                                                            | [SWE-bench](https://github.com/SWE-bench/SWE-bench) (5.7k, MIT), [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) (6.7k, MIT), [AgentKernelArena](https://github.com/AMD-AGI/AgentKernelArena) (Apache-2.0) | —          |
| Ajanın kendi telemetrisini geri okuması                                            | [tma1](https://github.com/tma1-ai/tma1) (Apache-2.0) — _"local-first observability your agent reads back"_                                                                                                               | Apache-2.0 |

Toplamı: **kendi kod tabanında hangi motoru hangi iş için kullanacağını
ampirik olarak söyleyen bir değerlendirme koşum takımı.** AgentSpace bunu
yapısal olarak sunamaz — sabit 8 motoru var ve bir verify döngüsü yok.

Bu, "AgentSpace'in modüllerini eklemek"ten farklı bir eksen: onlarla aynı
özellikleri kovalamak yerine, 12 motorlu olmanın **tek başına anlamlı olduğu**
bir yetenek. Yeni bir sürüm olarak planlanmalı (**M7 — Değerlendirme**), ve
M1'in `AgentEvent.usage` olayı ile M3'ün maliyet katmanı zaten onun altyapısı.
