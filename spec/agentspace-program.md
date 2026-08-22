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

## Teslim durumu (2026-08-22)

Dal `feat/engine-layer-m1`.

| Commit    | Kapsam                                                                                                                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `28b66f1` | **M1 çekirdeği** — S1.5 şeması (34 tabloda `owner_id`), `AgentEvent` sözleşmesi + normalizer'lar, deklaratif preset katmanı + 9 preset, argv geçişi, preset→registry (`/api/harnesses` 11 motor), ACP istemcisi + 191 test           |
| `da0b13c` | **Worktree başına port izolasyonu** (nerve deseni: deterministik offset, SQLite UNIQUE kayıt defteri, canlılık probu) ve **tree-hash verify önbelleği** (greentree deseni: geçici `GIT_INDEX_FILE` üzerinden gerçek git tree SHA'sı) |

**M1'de kasten yapılmayan:** ACP koşucusu — bkz. `spec/engine-layer.md` §6.

**Bilinen takip işleri:**

- `commitAll`, `.octomux/loop-status.json` ve `verify-cache.json`'ı görev dalına
  commit'liyor. Dar bir hariç tutma doğru çözüm ama `info/exclude` worktree'ler
  arasında paylaşılır ve pathspec zaten takipli bir dosyayı index'ten çıkarmaz —
  kendi değişikliğini hak ediyor. `.octomux/`'un tamamını hariç tutmak **yanlış**:
  `artifact.md` de orada ve `server/artifact.ts` amacını "it diffs" diye yazıyor.
- `server/pty.test.ts` `--parallel` altında yük-hassas flake veriyor (izole 6/6).
  Bir kez `error-middleware.test.ts`'te de görüldü. Bu değişikliklerden önce de vardı.

## Pazar sinyalleri (port edilecek kod yok)

Bunlar kapalı ticari ürünler. Referans haritasına girmezler — okunacak kaynak
yok. Konumlandırma bilgisi olarak burada.

### WorkBuddy (Tencent CodeBuddy) — codebuddy.cn/work

_"AI çalışma tezgâhı: bir kişi komuta eder, tüm sektörlerden uzmanlar uygular."_
100+ alan uzmanı, tek cümlelik komuttan otonom teslimata, çoklu uzman paralel
çalışması, MCP ekosistemi + özel Skills, çoklu model işbirliği. Masaüstü
(Windows/macOS/HarmonyOS) + WeChat mini-program + WeCom. Hedef segment açıkça
yazılı: **OPC 一人公司** — tek kişilik şirket, solo girişimci, mikro ekip.

**Alınacak tek fikir:** yazılım senaryosunda rol hattı açıkça tanımlı — ürün
müdürü gereksinimi belirler, mimar tasarlar _ve görevleri böler_, mühendisler
toplu uygular, QA doğrular — **ve "küçük gereksinimler hızlı mod destekler"**.
Karmaşıklığa göre yol ayrımı: her görev tam hattı hak etmiyor. octomux'un
`plugin/agents/` altında rolleri var ama bu kararı vermiyor.

**Doğruladığı iki bahsimiz:** çoklu motor (多模型协同) ve sohbet tabanlı hafif
ön yüz (bizde `server/gateway/`, Telegram + Slack).

**Stratejik okuma:** kapsamı bizden çok geniş — genel ofis işi, kodlama sadece
dört senaryodan biri. Yatay gidiyorlar. Bizim ayrımımız dikey olmalı: kodlama
ajanlarını _ölçülebilir_ biçimde yönetmek. M7 değerlendirme tezi tam bu farkı
derinleştiriyor; kapsam yarışına girmek onu köreltir.

### AgentSpace (Muratify)

Program bu ürünün yetenek yüzeyini hedef alıyor; envanteri ve modül eşlemesi
yukarıda. Kapalı kaynak, `~/.agentdesk`, sıfırdan yazılmış.

## Orkestratör taraması II (2026-08-22)

Dört repo incelendi. Üçü küçük (0–23★), biri 79★. Hepsi MIT. Kod olarak port
edilecek bir şey yok — katkıları fikir ve disiplin düzeyinde.

### [Agent Hive](https://github.com/intertwine/hive-orchestrator) — M7'yi yeniden şekillendiriyor

23★, MIT, Python. Konumu bizimle aynı: harness'ın _üstünde_ bir kontrol
düzlemi (Pi, OpenClaw, Hermes, Codex, Claude Code'un hepsini sürüyor).

Tek cümlesi M7 tezimizin somut hali:

> **"Agents do not decide when they are done. `PROGRAM.md` evaluators and
> promotion policy do."**

**octomux bugün:** ajan `octomux emit --status done` ile _kendi_ bitişini
beyan eder, yanına `--verify '<cmd>'` ikili bir geç/kal koyar.

**Hive'ın modeli kesinlikle daha güçlü:** tamamlanma kararı bildirimsel,
çoğul değerlendiricilere ve bir _terfi politikasına_ aittir — ajana değil.
Bir kabuk komutunun çıkış kodu tek ve kaba bir sinyal; bir değerlendirici
kümesi hem çoğuldur hem de repoya işlenmiş, incelenebilir bir sözleşmedir.

**M7 için karar:** `--verify`'ı korumak ama üstüne bir değerlendirici katmanı
koymak. Aday sıralaması (omp-best-of), ajanın kendi fazı (Grove `phase`),
çalıştırma makbuzu (h5i `box export`) ve maliyet (M3) bu katmanın girdileri
olur; tamamlanma kararını onlar verir.

İkinci fikir: _"Machine state stays explicit — tasks, runs, memory, events,
briefs live in predictable files instead of hidden session state."_ octomux'ta
`.octomux/` zaten bu; Hive bunu bir ilke olarak adlandırmış.

### [hermes-concurrent-agents](https://github.com/r0b0tlab/hermes-concurrent-agents) — yanlış alan, doğru disiplin

79★, MIT. Alanı NVIDIA GB10 / DGX Spark üzerinde **yerel GPU çıkarım
throughput'u** — bizim problemimiz değil. Ve sık paylaşılan modernizasyon
planı başında _"Historical and superseded. Do not execute"_ diyor; otoriter
olan `docs/current-state-report.md`.

Aktarılabilir üç pratik:

- **Reservation-before-claim admission** — kapasiteyi önce ayır, sonra işi
  al. `setup/ports.ts`'in UNIQUE-index tahkimi aynı şekil; ajan sevkiyatı
  için de doğru desen.
- **Telemetri yoksa muhafazakâr kabul** — ölçemiyorsan güvenli tarafa düş.
- **Üretilen support matrix sürüm iddiaları için otoriter**, ve CI "zorunlu
  kararlı sözleşmeler" ile "tavsiye niteliğinde drift probe"u ayırıyor.

Ve taklit edilmeye değer bir bölüm başlığı: **"Explicit limitations"** — ne
_yapmadıklarını_ sayıyorlar (uzak yerleşim yok, sandboxing iddiası yok,
sağlayıcı normalizasyonu yok). Bizim spec'lerimizdeki "kasten yapılmayan"
notlarının olgun hali.

**Aktarılmayan:** PID yeniden kullanımına karşı procfs start-tick sahipliği.
octomux **hiç PID takip etmiyor** — kimlik tmux oturum adı, canlılık
`pane_current_command`. Bu hata sınıfına yapısal olarak bağışık.

### [hydra](https://github.com/krowxx/hydra) — bir ucuz iyi fikir

0★ ama 169 dosya. Gemini/Codex/Claude'u paylaşılan HTTP daemon + görev
kuyruğu + worktree izolasyonuyla sürüyor.

> _"a local heuristic classifies your prompt and picks the best agent —
> **with zero extra API calls**"_

Yönlendirme için LLM'e ödeme yapmamak. 12 motorlu bir sistemde doğrudan
değerli, ve M7'nin "hangi motor hangi işte iyi" ölçümü bu sezgiseli
besleyebilir — ölçüm yönlendirmeyi eğitir.

### [SigmaLink / Claude-Multiplex](https://github.com/Tetrahedroned/Claude-Multiplex) — bir paketleme notu

0★, WIP. Electron 30 + TS 5.9, gerçek PTY'lerde ajan ızgaraları, worktree
izolasyonu. Bizimle aynı kategori ve **aynı konumda**: Linux'u aynı
`electron-builder.yml`'den derliyorlar ama test kapsamına almamışlar.

M6 için pratik nokta: macOS kurulumunu `curl | bash` ile yapıyorlar çünkü
`curl` indirilene `com.apple.quarantine` etiketi koymuyor — Gatekeeper'ın ilk
açılış uyarısı böylece hiç çıkmıyor.

### Yinelenen desen: rol hattı

Dört bağımsız kaynakta aynı yapı: **WorkBuddy** (PM → mimar → mühendisler →
QA), **hydra** (Claude önerir → Gemini eleştirir → Claude düzeltir → Codex
uygular), **claude-dev-system** (paperclip → openclaw → hermes), ve octomux'un
kendi `plugin/agents/`'ı (orchestrator / planner / reviewer).

Desen zaten bizde. Eksik olan tek parça WorkBuddy'nin eklediği şey:
**karmaşıklığa göre yol ayrımı** — "küçük gereksinimler hızlı mod destekler".
Her görev tam hattı hak etmiyor.
