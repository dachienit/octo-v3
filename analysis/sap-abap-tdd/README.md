# sap-abap-tdd — Phân tích ABAP package → Technical Document (TDD)

Skill mới thay cho `sap-abap-analysis-package`. Thiết kế lại từ đầu dựa trên yêu cầu và các sự
thật đo được trên **D8R**, không vá skill cũ.

## 1. Ý tưởng kiến trúc

Hai lần chạy live của skill cũ cho thấy: agent **chỉ đọc SKILL.md**, và model yếu sẽ **tự bịa
bước, bịa outline, bịa tên** khi được giao việc bằng văn xuôi. Vì vậy skill mới làm ngược lại:

| Việc | Ai làm |
|---|---|
| Quyết định bước tiếp theo, dựng argv cho `adt` | **Driver** `scripts/next.py` (state machine, tất định) |
| Gọi SAP | Agent, qua tool `adt`, **copy nguyên văn** JSON do driver in ra |
| Trích fact (bảng DB, FM, auth, message, class, T-code…) | **Script** `facts.py`, mỗi fact kèm `file:line` |
| Luồng dữ liệu: entry point → method → bảng / BAPI / output | **Script** `flow.py` (từ evidence `obj`/`unit` trong facts) |
| **Mọi chương**: bảng, số liệu, mermaid (kể cả Data Flow Diagram), roles, deletion, release notes | **Script** `compose.py` |
| Functional Description | **Không ai** — giữ nguyên hướng dẫn của template cho functional team |
| Văn dẫn nhập Chương 1 (tuỳ chọn) | **LLM**, chỉ khi `--with-prose`, từ packet fact, **không đọc source** |
| Lắp vào template + kiểm định | **Script** `template.py` (khuôn slot) + validator |

SKILL.md chỉ còn một vòng lặp: *chạy driver → làm đúng một ACTION nó in → chạy lại → tới DONE*.
Mặc định LLM **không viết gì**: các ACTION chỉ là lệnh `adt`/`sapgit` copy nguyên văn.

**Vì sao không để LLM viết (quyết định 2026-09-13):** skill phục vụ technical team. Hai lượt live
cho thấy task viết là chỗ vỡ: gpt-5-nano đọc 0/10 file source, tự `echo DONE`, chạy `bash -lc` (mở
WSL trên host), ghi đè note bằng stub 294 byte; còn Gemini thì mất 510/1677 dòng cuối của class vì
tool `read` cắt ở 50 KB. Bỏ Phần 2 (functional team tự viết) thì mọi phần còn lại đều sinh được từ
snapshot.

## 2. Pipeline

```
P0  sapgit clone (1 lần, chỉ để user xem trong UI — pipeline KHÔNG đọc từ đó)
P1a adt object list  --package X --json --output <run>/discover/<pkg>.json  từng package → đệ quy BFS qua node DEVC/K
P1  adt object pull  --depth 0  từng package → .scratchpad/tdd/<PKG>/<run>/src/<pkg>/
    sanity: không package nào có code → STOP (không DONE với tài liệu rỗng)
P1b adt --raw data sql  TSTC  (T-code → program, 1 lần, lỗi thì bỏ qua)
P1c adt --raw data sql  E071 → E070 → E07T  (3 truy vấn MỘT BẢNG, mỗi bước dùng kết quả bước trước;
    transport cho Release Notes; lỗi ở bước nào thì dùng phần đã có, hỏng từ E071 thì fallback ngày đổi)
P2  adt context build --depth 0 từng package có code → bundle/ (metrics, metadata, ddic.json; tuỳ chọn)
P3  facts.json (script) — kể cả methodCalls / unitCalls cho luồng dữ liệu
P4  compose: 21 slot sinh từ facts (Functional giữ nguyên template) → validate → .artifacts/<PKG>_Technical_Document.html
P5  (chỉ --with-prose) LLM viết văn Chương 1 từ packet fact → compose lại
```

Tài liệu đã đầy đủ ngay sau P4; P5 chỉ thêm văn. Model có bỏ ngang ở P5 thì user vẫn có tài liệu.

- **SAP là nguồn chân lý duy nhất.** Mỗi lần chạy là một snapshot mới trong
  `artifacts/<SYS>/.scratchpad/tdd/<PKG>/<runId>/`; không đọc/ghi thư mục package mà user đang sửa.
  `--new` tạo snapshot mới và xoá snapshot cũ của package đó.
- **Không tin exit code.** Mọi bước `adt` được kiểm bằng file trên đĩa (`.abap-package.json`,
  `manifest.json`, `tstc.xml`).
- **Template là khuôn:** output = bytes của template + fragment trong slot (có marker
  `<!-- tdd:slot … -->`). `verifySkeleton` chứng minh ngoài slot không đổi byte nào. Chỉ thay
  đoạn gợi ý xanh-nghiêng dưới mỗi heading, cộng với bảng form **mọi ô trống** ngay dưới heading
  (chỉ bảng Date/Transport/Comment của Release Notes). Bảng form có nội dung (OSS, Technical Debt)
  giữ nguyên. Slot không điền thì giữ hint gốc — Functional Description cố ý như vậy. Ba "slot"
  ngoài cây chương: `<title>`, `<h1>` đầu trang, dòng `docu-meta`; thêm đúng một cặp `<script>`
  mermaid trước `</body>`.
- **Data Flow Diagram** (slot h1 Technical Description): Transaction → report → các method public
  theo đúng thứ tự report gọi → bảng đọc / bảng ghi + BAPI thay đổi dữ liệu / ALV, e-mail; auth ghi
  trên node. Biến ref khai ở include TOP nhưng gọi ở I01 → `facts.py` lưu lời gọi thô rồi resolve
  trên cả họ report + include; method private được cộng dồn vào method public gọi nó (`unitCalls`).
- **Chống bịa (khi --with-prose):** fragment của LLM bị bỏ khỏi tài liệu nếu có `<h1>/<h2>/<script>`
  hoặc nêu tên object custom không có trong snapshot; driver giao lại task (tối đa 2 lần, sau đó
  Chương 1 chỉ còn phần tự sinh và ghi vào Limitations).
- Mục code không trả lời được (OSS, tech-debt rating, key figures, downtime…) ghi rõ
  *"Not derivable from static code analysis …"*. Local Role maintenance, Deletion and Phase-out,
  Release Notes nay đều sinh từ snapshot.

## 3. Sự thật đã đo trên D8R (probe thật qua tool `adt` của Octo, 2026-09-13)

| # | Sự thật | Hệ quả |
|---|---|---|
| 1 | `object pull` đặt tên file `/rb4r/x.clas.abap` nhưng **không tạo thư mục `rb4r/`** → **42/42 object `fetch-failed` (ENOENT)**; tạo sẵn thư mục thì **42/42 pulled** | Driver tạo sẵn thư mục namespace trước mỗi pull; ENOENT còn sót → học namespace, pull lại |
| 2 | Pull mặc định bỏ TRAN/MSAG/SUSH/TOBJ (`not-in-config`) | `--include-only` với danh sách đầy đủ (`lib.py` → `PULL_TYPES`) |
| 3 | `context build` parse được class namespace nhưng **mất namespace trong tên** (`MM_CL_QARR_ALV_LINE`) | `facts.py` chuẩn hoá lại tên theo inventory |
| 4 | `--with-where-used` cho 570 cạnh, đa số rác (`UNKN:PUBLIC SECTION`…) và làm chậm | Không dùng |
| 5 | `--with-docs`: D8R không trả long text | Không dùng |
| 6 | `object versions` → **404** trên D8R | Lịch sử transport tra bằng `data sql` trên E071/E070/E07T (P1c, **chưa verify live**); lỗi thì Release Notes dùng changedBy/changedAt |
| 7 | XML của TRAN **không có program** | Tra `TSTC` bằng `data sql` — **đã chạy thành công live** (run 20260913-145318) |
| 8 | `--output` toàn cục hoạt động cho `list`/`http`/`data` | Kết quả ghi thẳng ra file, không đi qua context model |
| 9 | Pull package quota (49 object) + 3 lệnh khác: 116 s tổng | Mỗi lệnh 1 package `--depth 0`; package lớn bị cắt 120 s → driver tự chia theo nhóm loại object |
| 11 | Function group bảo trì SE54 sinh tự động (`/RB4R/MM_EKF_U`, "Extended Table Maintenance (Generated)") mang theo member **chuẩn SAP tên bắt đầu bằng Z**: `ZURUECKHOLEN` (FORM undo), `ZWEISTUFIG` — lọt qua prefix `Z` của `pull-config.json`. Pull không lỗi, nhưng chiếm 1.199/3.228 dòng "code của package" (ZURUECKHOLEN còn bị adt-cli liệt kê 2 lần) và thêm `VIEWCLUSTER_UNDO_DEPENDENT` vào bảng consumed FM | `facts.py` bỏ qua (`SAP_STANDARD_MEMBER`), khử trùng lặp file, ghi vào `facts.skippedFiles` |
| 12 | adt-cli ghi tên file namespace **có `/` đầu** (`/rb4r/x.clas.abap`); Python `os.path.join` coi đó là tuyệt đối → cả package trông rỗng. Máy có `LongPathsEnabled=0`, file snapshot sâu ~240 ký tự | `_join_under` (ngữ nghĩa Node) + `lp()` (tiền tố `\\?\`) cho mọi I/O file |
| 13 | gpt-5-nano chép **thiếu đuôi argv** (mất `--out`) → adt pull vào mặc định `path.resolve("/rb4r/<pkg>")` = **gốc ổ `C:\rb4r\`**; nó cũng tự `sapgit branch/switch`, hỏi user giữa chừng, đọc file thay vì gọi `adt` | `--out` đặt ngay sau `pull`; SKILL.md + lời nhắc sau task viết: không dừng trước DONE/STOP |
| 10 | `subPackages` trong `.abap-package.json` = các package **pull đã walk** ngoài root (`adt-cli/src/commands/pull.js`), với `--depth 0` luôn `[]` | Cây package lấy bằng `object list` (nodestructure): root D8R trả 9 DEVC/K + 2 PINF. Live run đầu tiên chỉ phân tích root (2 PINF, 0 code) mà vẫn DONE — lý do có bước P1a + sanity check |
| 14 | Tool `read` của core-agent cắt ở **50 KB** (`core-agent/src/tools/read.ts:266`); class `/RB4R/CL_MM_PO_CLOSED` 62 KB bị cắt ở dòng 1167/1677 và model **không đọc tiếp bằng `offset`** → mất PROCESS_REQ_DELETE / BAPI_REQUISITION_DELETE | Không còn task nào bắt model đọc source |
| 15 | Lượt live gpt-5-nano (session `s_mtzybz5j_kmiol4`): mọi bước `adt` đúng, nhưng ở task viết thì đọc **0/10** file source, chạy `printf`/`bash -lc` (**mở WSL trên host**), tự `echo DONE`, tự ghép file TDD 2 KB, **ghi đè note 2,3 KB bằng stub 294 byte**; ~754k input không cache + 25k output (phần lớn reasoning) | Compose trước mọi task viết; mặc định không có task viết |
| 16 | Lượt "DONE đầu tiên" (session `s_mtzxoe4v_2kgnzn`) thật ra chạy **gemini-3.1-flash-lite rồi gemini-2.5-flash**, không phải gpt-5-nano; bị cắt 2 lần vì 429 (free tier 250k input/phút, cache-read cũng tính) | Không dùng lượt đó làm bằng chứng cho gpt-5-nano |
| 17 | Function group `/RB4R/MM_PO_CLOSED` **trùng tên** với report; evidence chỉ ghi tên object | `flow.py` loại unit là FM của group khỏi luồng của report |
| 21 | **JOIN NGẮN chạy trên D8R** (live 2026-09-14 02:20, `s_mu0m808z_x2vi7e`): JOIN E071 (DEVC) → E070 (K/W, R), 221 ký tự → 3 TR. Vậy #19 "chỉ một bảng" là diễn giải sai; thủ phạm của #19/#20 là **độ dài câu SQL**. Cùng ngày gpt-5-nano đọc lệnh E07T rồi bỏ qua → mất mô tả TR | Giữ mọi câu ≤ 240 ký tự; lookup data preview được 2 attempt (`MAX_LOOKUP_ATTEMPTS`) vì lệnh bị bỏ qua và lệnh bị SAP từ chối trông giống nhau (adt không ghi `--output` khi lỗi) |
| 20 | **Câu một bảng DÀI cũng bị từ chối.** Live D8R 2026-09-14 (`s_mu0l3pt1_9gnpt6`): `SELECT trkorr, obj_name FROM e071 WHERE obj_name IN ( …20 tên… )` (~700 ký tự) → HTTP 400 `Only one SELECT statement is allowed.`, trong khi TSTC ~80 ký tự chạy. Nghi endpoint cắt text thành dòng 255 ký tự (chưa verify) — nên có thể #19 cũng do độ dài chứ không phải JOIN | P1c chỉ tra **package object** (R3TR DEVC, theo yêu cầu user): thử JOIN ngắn E071→E070 (`TRFUNCTION IN ('K','W')`, `TRSTATUS = 'R'`, 221 ký tự), bị từ chối thì lùi E071 → E070 một bảng; mọi câu ≤ 240 ký tự (`MAX_SQL_CHARS`) |
| 19 | **Data preview của ADT chỉ nhận truy vấn MỘT BẢNG.** Live D8R 2026-09-13: `SELECT … FROM e071 INNER JOIN e070 … LEFT OUTER JOIN e07t …` → HTTP 400 `Only one SELECT statement is allowed.` (ADT_DATAPREVIEW_MSG 005); bỏ bớt còn một JOIN → `"TABLE" is invalid here (due to grammar).` (MSG 004). TSTC (một bảng) thì chạy tốt | P1c tách thành 3 truy vấn một bảng E071 → E070 → E07T, ghép trong `facts._parse_transports` |
| 18 | Report gọi class qua biến khai ở TOP (`go_po_closed TYPE REF TO …`) và gọi ở I01 (`go_po_closed->select_db_data( )`); `ref_types` của scanner chỉ sống trong 1 file | `facts.py` lưu lời gọi thô, resolve sau khi quét trên cả họ report + include |

## 4. Cấu trúc thư mục

```
sap-abap-tdd/
├── SKILL.md                 # vòng lặp driver + 5 luật (tiếng Anh, agent đọc)
├── README.md                # file này
├── template/Technical_Document.html   # copy nguyên từ analysis/template/
├── scripts/
│   ├── next.py             # driver / state machine
│   ├── lib.py              # path, state, PULL_TYPES, helper
│   ├── facts.py            # trích fact tất định từ snapshot (+ methodCalls, unitCalls, transports)
│   ├── flow.py             # chuỗi entry point → method → hiệu ứng dữ liệu (cho DFD)
│   ├── packets.py          # task viết tuỳ chọn (--with-prose): packet Chương 1, chỉ fact
│   ├── compose.py          # mọi chương + validate fragment + lắp template
│   └── template.py         # parse 22 slot, fill, verifySkeleton
└── test/
    ├── simulate.py         # chạy E2E offline driver bằng snapshot D8R đã ghi
    └── score.py            # chấm output so với doc mẫu (recall + tên bịa)
```

## 5. Cài vào Octo

Workspace cũ không tự nhận skill mới. Copy thư mục này vào skills của workspace (và template
`sap-abap` nếu muốn workspace mới có sẵn):

```bash
cp -r analysis/sap-abap-tdd workspace/workspaces/<ws>/skills/
```

Yêu cầu: **Python 3 (chỉ stdlib)** trong môi trường bash của agent — không `pip install`. Local đã có
Python 3.14; trong container BTP CF (Node buildpack) **chưa verify** có `python`/`python3`.

Bash của agent chạy với **cwd = `<ws>/artifacts`** (`core-agent/src/agent.ts`, `executorCwd`), nên
SKILL.md đưa lệnh tương đối `python ../skills/sap-abap-tdd/scripts/next.py` để model copy nguyên văn.
Live run #2 cho thấy lý do: được bảo "dùng đường dẫn thư mục chứa SKILL.md", gpt-5-nano tự ghép
thành `artifacts/skills/...` (sai), không tìm thấy file rồi bỏ cuộc. Từ vòng 2 trở đi driver in lệnh
tuyệt đối (`THEN:`), không còn phải suy đường dẫn.

Rồi chat: *"Create the technical document for package /RB4R/MM_PUR_DAT_COCKPIT on D8R"*.

## 6. Kiểm thử

```bash
# E2E offline (không gọi SAP), fixture tổng hợp tự chứa — không cần dữ liệu SAP trên đĩa:
#   tree  (mặc định) ZTDD_ROOT → A, B → B_SUB (code thật: report + TOP/I01 + class + TRAN/TABL/MSAG),
#         listing có chu trình + 1 listing lỗi → DONE kèm limitation; assert từng fact, DFD,
#         transport, Phần 2 = template, inventory đủ
#   leaf  package lá → DONE
#   empty root chỉ có PINF → STOP (không được DONE với tài liệu rỗng)
for s in tree leaf empty; do
  python test/simulate.py --work <thư mục tạm rỗng>/$s --scenario $s
done
# Task viết tuỳ chọn + đường reject-và-giao-lại:
python test/simulate.py --work <thư mục tạm rỗng> --scenario tree --with-prose

# Replay một run live đã có (discover/ src/ bundle/ meta/) — hồi quy script trên dữ liệu thật
python test/simulate.py --work <thư mục tạm rỗng> --scenario replay --record <run dir của live run>

# Chấm: heading, độ phủ snapshot, tên bịa (+ recall so với doc mẫu nếu có --example)
python test/score.py --generated <output.html> --facts <run>/facts.json [--example <thư mục doc mẫu>]
```

## 7. Còn mở

- Bản Python là port 1:1 của bản Node ban đầu: trên fixture tổng hợp `facts.json` và HTML **giống
  từng byte** (so bằng bản `.mjs` tham chiếu). Chỗ duy nhất không bảo đảm byte-identical: thứ tự
  sắp xếp tên bảng (JS `localeCompare` vs `locale_key` xấp xỉ ICU) khi tên chỉ khác ở `_`/chữ số.
- Python trên BTP CF chưa verify (xem §5).
- P1c bản "package object" (JOIN ngắn → fallback E071/E070) **chưa chạy live** (xem §3 #19, #20).
  Nhìn `run.json` `attempts`: có `transports:join` mà không có `transports:e071` = JOIN chạy được.
  Nếu vẫn hỏng: thử nhóm `cts` của adt-cli (`transports.js`: `list` cần một search configuration id).
- DFD chỉ theo entry point là report / T-code / FM cung cấp. Package chỉ có class (không report,
  không FM) thì slot ghi "No entry point…"; lời gọi xích (`a->b->m( )`) và lời gọi sang class ngoài
  snapshot không được theo.
- Package lớn (`/RB4R/MM_PURDOC_COCKPIT`, `/RB4R/MM_XLSX_FROM_ABAP`) có thể vượt 120 s dù chia nhóm;
  DFD lớn tự bỏ bớt bảng chỉ-đọc ít dùng (giới hạn 40 node), bảng Processing steps vẫn đủ.
- Trang con kiểu mẫu (API / EXCEL / Source List) để phase 2.
