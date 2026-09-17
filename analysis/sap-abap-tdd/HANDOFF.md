# Handoff — sap-abap-tdd (2026-09-14, sáng)

## MỚI NHẤT: 2 lượt live 02:20 / 02:26 — transport ĐÃ CHẠY LIVE

| | `s_mu0m808z_x2vi7e` — **gemini-3.1-flash-lite** | `s_mu0mffa0_duw268` — **gpt-5-nano** |
|---|---|---|
| Kết quả | DONE 4 phút 23, **0 degradation** | DONE lần đầu (7 phút 27), thiếu mô tả TR |
| Transport | JOIN chạy: D8RK949147 (2025-08-29), D6RK928063, D6RK926929 + mô tả E07T | cùng 3 TR; bỏ qua lệnh E07T |
| score.py | 19/19 object, 0 tên bịa, DFD 6 step, chỉ OSS "Not derivable" | y hệt |
| Token | 100k + 170k cache, 2,4k out, $0.033 | 469k không cache, 14,4k out |

- JOIN ngắn chạy → giới hạn thật là **độ dài câu SQL** (README §3 #21), không phải "một bảng".
- nano: bỏ qua 1 lệnh adt, tự `echo DONE` (SKILL.md cấm), 3 `read` lỗi, rồi mới gọi driver thật.
- **Đã vá:** lookup data preview được 2 attempt (`MAX_LOOKUP_ATTEMPTS`); simulate tree mô phỏng agent
  bỏ qua E07T lần đầu. Offline PASS. Chưa live.
- Còn treo: quyết định capability tool `abap_tdd` cho nano.

---

## Trước đó: 2 lượt live 01:49 / 01:56 ngày 14-09 + transport chỉ theo package object

| | `s_mu0l3pt1_9gnpt6` — **gemini-3.1-flash-lite** | `s_mu0ld47l_avhl1h` — **gpt-5-nano** |
|---|---|---|
| Kết quả | **DONE**, 5 phút 08 (gồm `context build`), tài liệu ở `artifacts/D8R/.gemini/.artifacts/` | **Không DONE**: làm đúng 4 bước (list, pull, TSTC), tới lệnh E071 thì viết text "đang chạy… sẽ tự động" rồi dừng |
| Transport | E071 (20 tên, ~700 ký tự) → HTTP 400 `Only one SELECT statement is allowed.` → Release Notes lùi về ngày đổi | chưa tới |
| Token | 85k + 130k cache, 2,2k out, $0.028 | 121k không cache, 4,8k out |

- nano lần này **không** tự đọc source/glob như lượt trước — hỏng kiểu mới: dừng lượt khi gặp argv dài.
  Kết luận không đổi: vòng lặp phải xuống capability tool nếu muốn dùng nano.
- **Đã sửa theo yêu cầu user:** chỉ lấy TR của package object. `next.py` step 1c: JOIN ngắn E071 (DEVC
  = package) → E070 (`K`/`W`, `R`), 221 ký tự; bị từ chối thì E071 một bảng → E070 lọc K/W/R; E07T
  lấy mô tả. Sort giảm dần trong `facts._parse_transports`. Mọi câu ≤ 240 ký tự. Offline PASS:
  tree (JOIN), leaf (JOIN bị từ chối → fallback), empty, --with-prose, replay. **Chưa live.**

---

# Handoff trước — sap-abap-tdd (2026-09-14, rạng sáng)

## 2 lượt live bản tất định (23:37 và 23:41 ngày 13-09) + bản vá transport

| | `s_mu01dxu1_ck278a` — **gpt-5-nano** | `s_mu01kdwv_sc9s38` — **gemini-3.1-flash-lite** |
|---|---|---|
| Kết quả | **Không DONE**, dừng giữa chừng, gửi "progress update" | **DONE trong 1 phút 35**, 1 tin nhắn user |
| Tài liệu | không có | 53.311 byte; score: 22/22 heading, 19/19 object, 16/16 FM, **0 tên bịa**, DFD 6 step, Phần 2 = template, chỉ OSS "Not derivable" |
| Token | 389k input không cache + 58k cache, 11,3k out, cost $0 (farm chưa khai giá) | 68k + 191k cache, 2,9k out, **$0.0261** |

- **nano vẫn phá vòng lặp dù không còn task viết:** sau `object pull` nó tự `read` thư mục (lỗi),
  `glob` 200 file, đọc class 62 KB làm 3 lần bằng `offset` (~35k token vô ích), đọc file không tồn
  tại, đọc một đường dẫn gõ sai (mất dấu `#`), rồi bỏ dở. → Muốn dùng nano thì phải đẩy vòng lặp
  xuống capability tool; Gemini chứng minh pipeline không có lỗi.
- **Transport: JOIN bị D8R từ chối** (xem README §3 #19). ĐÃ SỬA: P1c nay là **3 truy vấn một bảng**
  E071 → E070 → E07T (`next.py` `transport_lookup`, ghép trong `facts._parse_transports`, file
  `meta/transports-e07{1,0,t}.xml`). Offline PASS (tree/leaf/empty/--with-prose/replay), gồm cả luật
  "text tiếng Anh thắng bản tiếng Đức". **Chưa chạy live.**

---

# Handoff trước đó — sap-abap-tdd (2026-09-13, khuya)

## Quyết định của user (phiên này)

- Skill **chỉ phục vụ technical team**. **Phần 2 Functional Description giữ y nguyên template**
  (hướng dẫn gốc, không thêm câu nào); functional team tự viết.
- Phần 1, 3, 4, 5 phải **đủ technical object** và có **Data Flow Diagram** (mermaid flowchart).
- Model người dùng thật dùng: **gpt-5-nano** (LLM Farm). Baseline trước đây (`analysis/pre_test/`,
  `call-llm/src/analyze*.ts`: one-shot từ bundle `context build`, không source) được user chấm **5/10**.

## Đánh giá hai lượt live trước khi đổi thiết kế

| | Lượt A 21:53 (`s_mtzxoe4v_2kgnzn`) | Lượt B 22:11 (`s_mtzybz5j_kmiol4`) |
|---|---|---|
| Model thật | gemini-3.1-flash-lite → gemini-2.5-flash (HANDOFF cũ ghi nhầm nano) | gpt-5-nano-2025-08-07 |
| Kết quả | DONE, 22/22 heading, phủ 100%, 0 tên bịa; 1 câu bịa ("factory pattern"); class 62 KB bị `read` cắt ở 50 KB → thiếu PR delete, simulate/test mode | **Không DONE**: đọc 0/10 source, `printf`/`bash -lc` (mở WSL host), tự `echo DONE`, tự ghép TDD 2 KB, ghi đè note bằng stub 294 byte |
| Token | 214k input không cache + 703k cache, 5,8k output | ~754k không cache + 558k cache, ~25k output (reasoning) |

Kết luận: task viết nhiều lượt là chỗ vỡ → đổi sang tài liệu tất định.

## Trạng thái code (đã làm, offline PASS)

Luồng: `list → pull → tstc → transports (MỚI) → context build → facts → COMPOSE (đủ) → [--with-prose: 1 task Chương 1] → DONE`.

- `facts.py`: `methodCalls` (resolve biến ref qua họ report + include — TOP khai, I01 gọi),
  `unitCalls` (method private cộng dồn vào method public), `ddicFields`/`dataElements` từ
  `bundle/*/ddic.json`, `transports`/`transportsRead` từ `meta/transports.xml`.
- `flow.py` (mới): chuỗi entry point → step → hiệu ứng (reads/writes/BAPI change/commit/ALV/mail/auth).
- `compose.py`: DFD + bảng Processing steps (slot h1 Technical Description), Object inventory
  (mọi object), class diagram có method, fields + data elements, messages, Local Role maintenance,
  Deletion and Phase-out, Release Notes (transport hoặc fallback ngày đổi), Chương 1 tất định.
  Functional: không fragment → giữ template. Fragment LLM trượt validator thì bị bỏ, tài liệu vẫn ghi.
- `template.py`: bảng form mọi ô trống ngay dưới heading (Release Notes) được thay.
- `packets.py`: chỉ còn packet `intro` (fact, không source). `next.py`: bước transports (2 dạng
  SQL), compose trước task viết, `--with-prose`.
- `SKILL.md` v1.1.0: không task viết mặc định; cấm `echo/printf/bash -lc`; chỉ driver in DONE.

Kiểm chứng:
- `simulate.py`: tree / leaf / empty / tree `--with-prose` PASS (assert DFD, TOP/I01, transport
  gom theo request, Phần 2 = template, inventory đủ, bảng trống Release Notes bị thay).
- Replay snapshot thật `run 20260913-154605` (CLOSING_PO): DONE sau 6 bước adt, **0 task viết**;
  score: 22/22 heading, allObjects 19/19, 0 tên bịa, DFD 6 step (SELECT_DB_DATA → PROCESS_DATA
  [M_BEST_EKO/M_BANF_EKO] → PROCESS_PO_CLOSE [BAPI_PO_CHANGE] → PROCESS_REQ_DELETE
  [BAPI_REQUISITION_DELETE] → PROCESS_EMAIL [USR21/ADR6 → e-mail] → DISPLAY_DATA [ALV]);
  chỉ OSS còn "Not derivable".
- Render Chromium (scratchpad `c86453c3…/render.mjs`): mermaid 4/4 render, 0 syntax error, 0 console error.

## Việc tiếp theo

1. **Live bằng Gemini, 1 tin nhắn** trên D8R `/RB4R/MM_AUTOMAT_CLOSING_PO`: kiểm 3 truy vấn transport
   mới có ra dữ liệu không (`meta/transports-e071.xml` …), cột Transport trong Release Notes hết
   "n/a", `run.json` không còn degradation về transport.
2. gpt-5-nano: quyết định giữ nguyên (dùng model khác) hay làm capability tool `abap_tdd`.
3. Package chỉ có class (không report/FM) → DFD trống; cân nhắc lùi về mức object.

## Việc treo — cần user quyết (không đổi)

- Nhánh git `feature/tdp/mm-automat-closing-po` trong `artifacts/D8R` (gpt-5-nano tự tạo), thư mục
  rác `C:\rb4r\mm_automat_closing_po\`, `artifacts/D8R/.gitignore` thiếu.
- Python trên BTP CF container chưa verify.
- Model farm `cm_mtsbu3wp_10ac70fb4d2e` chưa khai giá → trail báo cost $0.

## Cách chạy lại

```bash
# offline (work dir NGẮN)
python test/simulate.py --work %TEMP%\tddX --scenario tree        # tree | leaf | empty  [--with-prose]
python test/simulate.py --work %TEMP%\tddR --scenario replay --record <run dir live>
python test/score.py --generated <html> --facts <run>/facts.json
node <scratchpad c86453c3…>/render.mjs <html> <prefix>              # proxy 127.0.0.1:3128
```
