# Handoff — skill `sap-abap-analysis-package`

Bàn giao cho session mới. Trạng thái tại 2026-09-10, sau **hai lần chạy live** trên S4X /
`ZPK_IYH1HC`. Skill đang ở **v0.3.0** và vẫn còn lỗi; phần "Việc cần fix" ở cuối là việc chính.

---

## 1. Skill này là gì, nằm ở đâu

Phân tích một package ABAP → tài liệu kỹ thuật HTML theo template TDD của Bosch.

**Nguồn sự thật:**

```
octo-v2/core-service/templates/sap-abap/skills/sap-abap-analysis-package/
├── SKILL.md          # 11 step, mọi lệnh viết literal
├── README.md
├── references/
│   ├── adt.md        # flag table của adt, bundle layout, bẫy
│   ├── sapgit.md     # tham số sapgit, cơ chế clone
│   └── document.md   # cách đọc bundle + output contract
├── template/
│   ├── Technical_Document.html   # template TDD, export từ Docupedia (space CDS4)
│   ├── Technical_Document.md     # cùng nội dung, markdown
│   └── manifest.json             # manifest export của docu-cli — KHÔNG thuộc output
└── example/          # rỗng (chỉ .gitkeep)
```

**KHÔNG sửa** `core-service/deploy/templates/` (sinh bởi `scripts/assemble-deploy.mjs`, đã gitignore).

**Bản chạy thật nằm ở nơi khác** — workspace cũ không tự nhận skill mới (template chỉ copy lúc
*tạo* workspace). Sau mỗi lần sửa phải sync tay:

```bash
cd octo-v2
src=core-service/templates/sap-abap/skills/sap-abap-analysis-package
cp -r "$src/." workspace/workspaces/ws_mttjwesp_prqm8s/skills/sap-abap-analysis-package/
cp -r "$src/." workspace/templates/sap-abap/skills/sap-abap-analysis-package/
```

Đã đăng ký trong `core-service/templates/sap-abap/template.json` + một câu trong `AGENTS.md`.
Có carve-out trong `skills/sap-adt-cli/SKILL.md` cho phép skill này dùng `auth` group (skill đó
cấm; chỗ khác giữ nguyên lệnh cấm). SKILL/README của skill này **không nhắc tên skill khác** —
đó là yêu cầu của user.

---

## 2. PHÁT HIỆN QUAN TRỌNG NHẤT — đọc trước khi sửa bất cứ thứ gì

**Agent đọc `SKILL.md` và KHÔNG đọc thêm bất kỳ file nào khác của skill.** Đo được ở **cả hai**
lần chạy: `references/adt.md`, `references/sapgit.md`, `references/document.md`,
`template/Technical_Document.md` — **0/4 được đọc**, kể cả khi SKILL.md ghi in hoa "you MUST have
read".

Lý do cơ chế: prompt chỉ đưa agent `<skill><name><description><location>…SKILL.md</location>`.
Đọc SKILL.md là bắt buộc (có đường dẫn). Mọi hop sau đó là **link markdown trong văn xuôi** →
tự nguyện → không xảy ra.

> **LUẬT: thứ gì agent phải tái tạo/chạy CHÍNH XÁC thì phải nằm TRONG `SKILL.md`.**
> `references/` chỉ để giải thích flag, bẫy, lý do — không bao giờ chứa thứ agent buộc phải dùng.

Bằng chứng luật này đúng: khi tôi đưa argv literal vào SKILL.md ở v0.3.0, lần chạy 2 gọi
`context build` **đúng 15/15 argument**. Khi để dạng văn xuôi ở v0.2.0, lần chạy 1 gọi **2/9**.

---

## 3. Hai lần chạy live

| | Run 1 `s_mtv06g8a_5zcq4d` (v0.2.0) | Run 2 `s_mtv12mpi_5dac5v` (v0.3.0) |
|---|---|---|
| Tool call | 12 | 28 |
| Output HTML | 1 626 B | 4 982 B |
| `context build` argv | **2/9** ❌ | **15/15** ✅ |
| Clone sub-package | không ❌ | có ✅ |
| `object source` | 0 lần ❌ | 3 lần ✅ |
| Đọc `tree.json` | không ❌ | 3 lần ✅ |
| Đọc `structure.json`/`dependencies.json`/`metrics.json` | không ❌ | **vẫn không** ❌ |
| Đọc `template/Technical_Document.md` | không ❌ | **vẫn không** ❌ |
| Heading | 5 mục tự bịa ❌ | **22 mục tự bịa** ❌ |
| Mermaid | 0 ❌ | 2 (yêu cầu ≥3, kể tên 5 loại) ⚠️ |
| Reuse `<style>` template | không ❌ | **vẫn không** ❌ |
| bash calls (skill cấm) | 2 | **6** ❌ |

Workspace: `ws_mttjwesp_prqm8s`. Model: Gemini 3.1. **Không phải lỗi model** — agent làm đúng
những gì SKILL.md đặt trước mắt nó.

### Bốn lỗi đã fix ở v0.3.0

1. **Indirection qua reference** → đưa argv literal vào SKILL.md (mục 2 ở trên).
2. **`sapgit clone` chỉ một tầng.** `planChildren` (`core-service/src/sapTree.ts:281-338`) ghi
   sub-package là `loaded: false` và **không đệ quy**. Run 1 clone `ZPK_IYH1HC` ra đúng **1 file**;
   34 object trong `ZPK_IYH1HC_RAP_ADOBE` không hề được pull. → thêm step 5 lặp `tree.json` →
   clone từng sub-package tới khi hết `loaded: false`. Sub-package nằm **ngang hàng** ở gốc
   connection, không lồng.
3. **Check "đã clone chưa" bằng glob là sai.** Mirror lazy: folder + file 0 byte có trước khi
   fetch. → step 3 đọc `.adt/tree.json`.
4. **`--out` bị thêm tên package** → `.scratchpad/<PKG>/<PKG>/`, lệch mọi path của step verify
   (nên step verify không chạy được). Tool tự append `/<PACKAGE>`; `--out` dừng ở `.scratchpad`.

---

## 4. LỖI CÒN LẠI (việc của session mới)

### 4.1 Model đếm tới 22 rồi bịa ra 22 mục của riêng nó — ƯU TIÊN 1

SKILL.md v0.3.0 ghi: *"there are **22 headings** and you must reproduce every one"* và bảo đọc
`template/Technical_Document.md`. Model **không đọc template**, nhưng thấy con số 22, nên sinh ra
đúng 22 heading **do nó tự nghĩ**:

```
1. Executive Summary        2. Business Value       3. Architecture Overview
4. Package Structure        5. Data Model           6. APIs and External Interfaces
7. Process Flows            8. Key Classes …        … 22. Document Metadata
```

Template thật là: `Motivation and Key Figures` / `Functional Description` /
`Technical Description (High-Level Architecture)` / `Deployment` / `Release Notes` + 17 H2.

Thêm nữa: model để **tất cả là H2** (phẳng), còn template là **5×H1 + 17×H2**.

> **Bài học: nêu SỐ LƯỢNG thay vì NỘI DUNG là mời model bịa cho đủ số.**

**Fix:** nhúng **nguyên văn 22 heading (kèm cấp H1/H2) vào trong SKILL.md**, dạng khung HTML sẵn
để agent điền. Bỏ hoặc hạ vai trò con số "22". Cùng luật ở mục 2.

Cây chương mục đúng đã có trong `references/document.md` (đã diff khớp template 22/22) — bê
nguyên sang SKILL.md.

### 4.2 Không reuse `<style>` của template — ƯU TIÊN 1

Vì không đọc template. Output tự viết CSS, không có `prefers-color-scheme`. **Fix:** nhúng
thẳng block `<style>` vào SKILL.md (hoặc chỉ thị copy y nguyên kèm nội dung block).

### 4.3 Không đọc `structure.json` / `dependencies.json` / `metrics.json` — ƯU TIÊN 2

Cả hai lần. Chỉ đọc `CONTEXT.md` ×2 + `manifest.json` ×1 (và bỏ `manifest.json` của package gốc).
Nên "Key Classes", data model, process flow đều thiếu chất. Bundle chỉ vài trăm token — không
phải vấn đề context.

**Fix gợi ý:** biến step 9 thành danh sách đường dẫn tuyệt đối phải đọc, đánh số, thay vì mô tả
chung; hoặc bắt liệt kê ra từng file đã đọc trước khi được viết tài liệu.

### 4.4 Chỉ 2 mermaid, yêu cầu ≥3 và kể tên 5 loại — ƯU TIÊN 2

**Fix:** nêu rõ từng diagram bắt buộc kèm skeleton mermaid mẫu **trong SKILL.md**.

### 4.5 Dùng bash 6 lần dù skill cấm — ƯU TIÊN 3

`ls -R` ×4, `pwd`, `mkdir -p`. Agent đang mò đường dẫn: đọc `tree.json` bằng cả đường tuyệt đối
lẫn tương đối, và cwd của bash khác workspace root. **Fix:** cho SKILL.md nói rõ mọi path đều
tính từ workspace root và nêu cách lấy đường tuyệt đối, thay vì chỉ cấm bash.

### 4.6 Step verify (step 8) không có bằng chứng đã chạy — ƯU TIÊN 3

Run 2 dùng `bash ls -R S4X/.scratchpad` thay cho glob `manifest.json` như skill yêu cầu. Kết quả
tình cờ đúng, nhưng không phải cái đã đặc tả.

---

## 5. Cân nhắc: hết đường prompt thì phải sửa code

Đã hai lần cho thấy chữ **MUST** + checklist làm tăng tuân thủ chứ **không đảm bảo**. Nếu vòng
sửa prompt tiếp theo vẫn rớt, các đường cưỡng chế bằng code (đều **ngoài** phạm vi skill, chưa
làm, cần user đồng ý):

- Cho `sapgit clone` **tự đệ quy** sub-package → `core-service/src/capabilities/sapgit-tool.ts`
  (bỏ hẳn step 5, xoá luôn một nguồn lỗi).
- Nới timeout 120s cho nhánh capability tool → `core-service/src/http.ts` (`runAdtCli`), xem 6.2.
- Sinh sẵn khung HTML 22 heading bằng code, agent chỉ điền nội dung → không còn cửa bịa outline.

---

## 6. Sự thật runtime đã đo — đừng suy lại

### 6.1 Đã verify bằng cách chạy thật

- `auth profile list` trạng thái rỗng → `{"defaultProfile": null, "profiles": []}`, **exit 0**.
  Phải đọc giá trị, không đọc exit code.
- `auth profile use NOPE` → `ERR  Profile "NOPE" does not exist.` exit 1.
- `--strip aggressive` (2 argv) parse **y hệt** `--strip=aggressive` — Commander nuốt đối số kế
  tiếp cho option `[optional]`. Không phải bẫy.
- Egress trực tiếp tới `cdn.jsdelivr.net` **bị chặn** (curl 000); qua proxy `127.0.0.1:3128` →
  200. Iframe preview của Artifacts panel có `sandbox="allow-scripts allow-same-origin"` và
  **không CSP** → script chạy được, nhưng fetch từ browser user nên phụ thuộc PAC.
- `.artifacts/` **hiện** trong Artifacts panel dù bị gitignore — `HIDDEN_ARTIFACT_DIRS`
  (`core-service/src/http.ts:230`) chỉ ẩn `.git`.
- **KHÔNG truyền `--config`** cho `context build`: đó là file **abaplint**, không phải pull-config.
  Đưa `pull-config.json` vào **không lỗi** — cho ra config `rules: 0`, `syntax.version` v758 thay
  vì v757, `global.files` `/src/**` thay vì `/abap/**`, tức âm thầm ghi đè `.adt/abaplint.json`
  đúng đắn. Mà flag này **dư thừa**: cwd đã là thư mục connection nên adt-cli tự tìm
  `<cwd>/.adt/abaplint.json` (layer 2) và `.adt/pull-config.json` (layer 3), cả hai do
  `seedAdtConfigs` (`http.ts:1884`) gieo lúc tạo connection.

### 6.2 Bẫy timeout im lặng

Tool `adt` không truyền `timeoutMs` → `runAdtCli` mặc định **120 s** (`http.ts:1497`). Hết giờ →
`SIGTERM` → handler `close` trả `exitCode: code ?? 0`, mà `code` là `null` khi bị giết bằng
signal (`http.ts:1526-1532`). **Lệnh bị cắt giữa chừng báo về exit 0** kèm bundle dở dang. Đó là
lý do step 8 (verify bằng file trên đĩa) tồn tại.

### 6.3 cwd của tool `adt`

`cwd = sapConnDir(workspaceId, profileName)` = `<workspaceRoot>/artifacts/<profile>` khi profile
resolve được (`http.ts:470`), tụt về `workingDir` khi không. Nên **mọi path trong argv phải tuyệt
đối**. (Câu "the tool's working directory is not the connection folder" trong
`skills/sap-adt-cli/SKILL.md` **đã sai** — chưa sửa, ngoài phạm vi.)

### 6.4 `structure.json` mỏng là ĐÚNG BẢN CHẤT, không phải bug

- RAP behaviour pool (`ZBP_*`) → `methodCount: 0`, vì handler nằm ở local class (`lhc_*`) mà
  skeleton không với tới.
- Class gateway sinh tự động (`*_DPC`, `*_DPC_EXT`, `*_MPC`) → `"error": "no class definition
  parsed"`, vì kế thừa class chuẩn SAP không có trong bundle.
- Class lấy method từ interface → không hiện method của riêng nó.

Cách chữa là **đọc source** (step 10), không phải đổi flag. **Đừng bao giờ** viết "class này không
có method" từ `methodCount: 0`.

### 6.5 Nơi lấy `<source_url>`

`manifest.json` → `objects[].uri` (sinh bởi `adt-cli/src/context/metadataExtractor.js:101`).
Đừng tự dựng URL.

### 6.6 Layout bundle

`context build` ghi ra `<out>/<PACKAGE>/`, mỗi package một thư mục; với `--depth 5` mỗi
sub-package có thư mục **ngang hàng**. Mỗi thư mục gồm `manifest.json` (có `objectCount`,
`subPackages`, `generatedAt`), `structure.json`, `dependencies.json`, `metrics.json`,
`CONTEXT.md`, thêm `ddic.json` / `docs/` tuỳ nội dung và flag.

---

## 7. Cách kiểm chứng lần sau

**Tĩnh (chạy được ngay):**

```bash
cd octo-v2/core-service/templates/sap-abap/skills/sap-abap-analysis-package
# link resolve, JSON block parse, frontmatter, cây chương mục khớp template
node -e "…"   # script đã dùng: check ]( link ), ```json blocks, js-yaml frontmatter,
              # và diff 22 heading của template/Technical_Document.md với khung trong SKILL.md
```

**Live:** sync skill sang workspace (mục 1), chat trong `ws_mttjwesp_prqm8s`
(đã connect S4X): *"phân tích package ZPK_IYH1HC"*.

**Đo kết quả bằng số, đừng đọc cảm tính** — script này đã dùng và phát hiện ra vụ "22 mục bịa":

```bash
node -e "
const h=require('fs').readFileSync('<out>.html','utf8');
const heads=[...h.matchAll(/<(h[12])[^>]*>([\s\S]*?)<\/\1>/gi)].map(m=>m[1]+' '+m[2].replace(/<[^>]*>/g,'').trim());
console.log(heads.length, heads);
console.log('mermaid:', (h.match(/class=\"mermaid\"/g)||[]).length);
console.log('template style reused:', /prefers-color-scheme/.test(h));
"
```

Và đếm tool call trong `workspace/workspaces/<ws>/sessions/<s>/trail.jsonl` — entry
`{ts, runId, event:{type:'tool', phase:'call', toolName, args}}`. Kiểm 4 điều: có đọc
`template/Technical_Document.md` chưa; `context build` có đủ 15 argv; có đọc `structure.json`
chưa; có bao nhiêu bash call.

---

## 8. Nhắc cuối

- Toàn bộ identifier / comment / string trong source phải **tiếng Anh**; chat và tài liệu bàn
  giao tiếng Việt thì được.
- `example/` vẫn rỗng, không có gì phụ thuộc vào nó.
- Chưa bao giờ verify trên BTP, chỉ local.
