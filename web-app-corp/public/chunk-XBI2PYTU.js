import {
  mapsToWasmPackage,
  wasmPackageToArrayBuffer,
  wasmPackageToMaps,
  wasmParseDocx
} from "./chunk-WKBPLHUA.js";

// ../ooxml-core/src/index.ts
async function parseDocx(input) {
  const wasmPackage = await wasmParseDocx(input);
  const { parts, binaryAssets } = wasmPackageToMaps(wasmPackage);
  return { parts, binaryAssets };
}
async function packageToArrayBuffer(pkg) {
  return wasmPackageToArrayBuffer(mapsToWasmPackage(pkg));
}
function createMinimalDocxPackage(documentXml = DEFAULT_DOCUMENT_XML) {
  return {
    parts: /* @__PURE__ */ new Map([
      ["[Content_Types].xml", { name: "[Content_Types].xml", content: DEFAULT_CONTENT_TYPES_XML }],
      ["_rels/.rels", { name: "_rels/.rels", content: DEFAULT_ROOT_RELS_XML }],
      ["word/document.xml", { name: "word/document.xml", content: documentXml }],
      [
        "word/_rels/document.xml.rels",
        { name: "word/_rels/document.xml.rels", content: DEFAULT_DOCUMENT_RELS_XML }
      ]
    ]),
    binaryAssets: /* @__PURE__ */ new Map()
  };
}
function getPart(pkg, partName) {
  return pkg.parts.get(partName);
}
function withPart(pkg, part) {
  const parts = new Map(pkg.parts);
  parts.set(part.name, part);
  return {
    parts,
    binaryAssets: new Map(pkg.binaryAssets)
  };
}
var WORD_MAIN_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
var DEFAULT_DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${WORD_MAIN_NS}">
  <w:body>
    <w:p><w:r><w:t/></w:r></w:p>
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
var DEFAULT_CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
var DEFAULT_ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
var DEFAULT_DOCUMENT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

export {
  parseDocx,
  packageToArrayBuffer,
  createMinimalDocxPackage,
  getPart,
  withPart
};
//# sourceMappingURL=chunk-XBI2PYTU.js.map