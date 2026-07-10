import {
  mapsToWasmPackage,
  wasmBuildDocModelFromPackage
} from "./chunk-WKBPLHUA.js";

// ../doc-model/src/normalize.ts
function normalizeUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value);
  }
  return void 0;
}
function normalizeParagraphChild(child) {
  if (child.type !== "image") {
    return child;
  }
  const image = child;
  const data = normalizeUint8Array(image.data);
  if (data === image.data) {
    return child;
  }
  return {
    ...image,
    data
  };
}
function normalizeTableCellContent(node) {
  if (node.type === "table") {
    return normalizeDocNode(node);
  }
  return {
    ...node,
    children: node.children.map(normalizeParagraphChild)
  };
}
function normalizeDocNode(node) {
  if (node.type === "paragraph") {
    return {
      ...node,
      children: node.children.map(normalizeParagraphChild)
    };
  }
  return {
    ...node,
    rows: node.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) => ({
        ...cell,
        nodes: cell.nodes.map(normalizeTableCellContent)
      }))
    }))
  };
}
function normalizeDocModel(model) {
  return {
    ...model,
    nodes: model.nodes.map(normalizeDocNode),
    metadata: {
      ...model.metadata,
      headerSections: model.metadata.headerSections.map((section) => ({
        ...section,
        nodes: section.nodes.map(normalizeDocNode)
      })),
      footerSections: model.metadata.footerSections.map((section) => ({
        ...section,
        nodes: section.nodes.map(normalizeDocNode)
      })),
      sections: model.metadata.sections?.map((section) => ({
        ...section,
        headerSections: section.headerSections.map((header) => ({
          ...header,
          nodes: header.nodes.map(normalizeDocNode)
        })),
        footerSections: section.footerSections.map((footer) => ({
          ...footer,
          nodes: footer.nodes.map(normalizeDocNode)
        }))
      })),
      footnotes: model.metadata.footnotes?.map((note) => ({
        ...note,
        nodes: note.nodes?.map(normalizeDocNode)
      })),
      endnotes: model.metadata.endnotes?.map((note) => ({
        ...note,
        nodes: note.nodes?.map(normalizeDocNode)
      }))
    }
  };
}

// ../doc-model/src/clone.ts
function isParagraphCellContent(node) {
  return node.type === "paragraph";
}
function isTableCellContentTable(node) {
  return node.type === "table";
}
function cloneTableCellContent(nodes) {
  return nodes.map((node) => {
    if (isParagraphCellContent(node)) {
      return cloneParagraph(node);
    }
    if (isTableCellContentTable(node)) {
      return cloneTable(node);
    }
    return node;
  });
}
function cloneParagraphNumbering(numbering) {
  return numbering ? { ...numbering } : void 0;
}
function cloneParagraphSpacing(spacing) {
  return spacing ? { ...spacing } : void 0;
}
function cloneParagraphIndent(indent) {
  return indent ? { ...indent } : void 0;
}
function cloneParagraphBorderStyle(border) {
  return border ? { ...border } : void 0;
}
function cloneParagraphBorderSet(borders) {
  if (!borders) {
    return void 0;
  }
  return {
    top: cloneParagraphBorderStyle(borders.top),
    right: cloneParagraphBorderStyle(borders.right),
    bottom: cloneParagraphBorderStyle(borders.bottom),
    left: cloneParagraphBorderStyle(borders.left),
    between: cloneParagraphBorderStyle(borders.between),
    bar: cloneParagraphBorderStyle(borders.bar)
  };
}
function cloneParagraphStyle(style) {
  if (!style) {
    return void 0;
  }
  return {
    ...style,
    numbering: cloneParagraphNumbering(style.numbering),
    spacing: cloneParagraphSpacing(style.spacing),
    indent: cloneParagraphIndent(style.indent),
    borders: cloneParagraphBorderSet(style.borders),
    dropCap: style.dropCap ? {
      ...style.dropCap
    } : void 0
  };
}
function cloneParagraph(paragraph) {
  return {
    type: "paragraph",
    style: cloneParagraphStyle(paragraph.style),
    paragraphMarkDeleted: paragraph.paragraphMarkDeleted,
    sourceXml: paragraph.sourceXml,
    children: paragraph.children.map((child) => {
      if (child.type === "text") {
        return {
          type: "text",
          text: child.text,
          style: child.style ? { ...child.style } : void 0,
          link: child.link
        };
      }
      if (child.type === "form-field") {
        return {
          type: "form-field",
          fieldType: child.fieldType,
          sourceKind: child.sourceKind,
          id: child.id,
          tag: child.tag,
          title: child.title,
          placeholder: child.placeholder,
          checked: child.checked,
          value: child.value,
          options: child.options?.map((option) => ({
            displayText: option.displayText,
            value: option.value
          })),
          widget: child.widget ? {
            name: child.widget.name,
            enabled: child.widget.enabled,
            calcOnExit: child.widget.calcOnExit,
            text: child.widget.text ? {
              inputType: child.widget.text.inputType,
              defaultText: child.widget.text.defaultText,
              maxLength: child.widget.text.maxLength,
              textFormat: child.widget.text.textFormat
            } : void 0,
            checkbox: child.widget.checkbox ? {
              defaultChecked: child.widget.checkbox.defaultChecked,
              sizeMode: child.widget.checkbox.sizeMode,
              sizePt: child.widget.checkbox.sizePt
            } : void 0,
            dropdown: child.widget.dropdown ? {
              defaultValue: child.widget.dropdown.defaultValue
            } : void 0
          } : void 0,
          checkedSymbol: child.checkedSymbol,
          uncheckedSymbol: child.uncheckedSymbol,
          style: child.style ? { ...child.style } : void 0,
          link: child.link,
          sourceXml: child.sourceXml
        };
      }
      return {
        type: "image",
        src: child.src,
        alt: child.alt,
        widthPx: child.widthPx,
        heightPx: child.heightPx,
        partName: child.partName,
        contentType: child.contentType,
        data: child.data ? new Uint8Array(child.data) : void 0,
        sourceXml: child.sourceXml,
        crop: child.crop ? { ...child.crop } : void 0,
        cssFilter: child.cssFilter,
        cssOpacity: child.cssOpacity,
        floating: child.floating ? { ...child.floating } : void 0,
        syntheticTextBox: child.syntheticTextBox,
        textBoxText: child.textBoxText
      };
    })
  };
}
function cloneTableBoxSpacing(spacing) {
  if (!spacing) {
    return void 0;
  }
  return {
    topTwips: spacing.topTwips,
    rightTwips: spacing.rightTwips,
    bottomTwips: spacing.bottomTwips,
    leftTwips: spacing.leftTwips
  };
}
function cloneTableBorderStyle(border) {
  if (!border) {
    return void 0;
  }
  return {
    type: border.type,
    color: border.color,
    sizeEighthPt: border.sizeEighthPt
  };
}
function cloneTableBorderSet(borders) {
  if (!borders) {
    return void 0;
  }
  return {
    top: cloneTableBorderStyle(borders.top),
    right: cloneTableBorderStyle(borders.right),
    bottom: cloneTableBorderStyle(borders.bottom),
    left: cloneTableBorderStyle(borders.left),
    insideH: cloneTableBorderStyle(borders.insideH),
    insideV: cloneTableBorderStyle(borders.insideV),
    tl2br: cloneTableBorderStyle(borders.tl2br),
    tr2bl: cloneTableBorderStyle(borders.tr2bl)
  };
}
function cloneTableFloatingStyle(floating) {
  if (!floating) {
    return void 0;
  }
  return {
    xTwips: floating.xTwips,
    yTwips: floating.yTwips,
    leftFromTextTwips: floating.leftFromTextTwips,
    rightFromTextTwips: floating.rightFromTextTwips,
    topFromTextTwips: floating.topFromTextTwips,
    bottomFromTextTwips: floating.bottomFromTextTwips,
    horizontalAnchor: floating.horizontalAnchor,
    verticalAnchor: floating.verticalAnchor,
    horizontalAlign: floating.horizontalAlign,
    verticalAlign: floating.verticalAlign
  };
}
function cloneTable(table) {
  return {
    type: "table",
    sourceXml: table.sourceXml,
    style: table.style ? {
      widthTwips: table.style.widthTwips,
      indentTwips: table.style.indentTwips,
      layout: table.style.layout,
      cellSpacingTwips: table.style.cellSpacingTwips,
      floating: cloneTableFloatingStyle(table.style.floating),
      cellMarginTwips: cloneTableBoxSpacing(table.style.cellMarginTwips),
      columnWidthsTwips: table.style.columnWidthsTwips ? [...table.style.columnWidthsTwips] : void 0,
      borders: cloneTableBorderSet(table.style.borders)
    } : void 0,
    rows: table.rows.map((row) => ({
      type: "table-row",
      style: row.style ? { ...row.style } : void 0,
      cells: row.cells.map((cell) => ({
        type: "table-cell",
        style: cell.style ? {
          ...cell.style,
          marginTwips: cloneTableBoxSpacing(cell.style.marginTwips),
          borders: cloneTableBorderSet(cell.style.borders)
        } : void 0,
        nodes: cloneTableCellContent(cell.nodes)
      }))
    }))
  };
}
function cloneDocNode(node) {
  return node.type === "paragraph" ? cloneParagraph(node) : cloneTable(node);
}
function cloneNumberingDefinitions(numberingDefinitions) {
  if (!numberingDefinitions) {
    return void 0;
  }
  return {
    abstracts: numberingDefinitions.abstracts.map((abstractDefinition) => ({
      abstractNumId: abstractDefinition.abstractNumId,
      levels: abstractDefinition.levels.map((level) => ({
        ...level,
        runStyle: level.runStyle ? { ...level.runStyle } : void 0,
        pictureBullet: level.pictureBullet ? { ...level.pictureBullet } : void 0
      }))
    })),
    instances: numberingDefinitions.instances.map((instanceDefinition) => ({
      numId: instanceDefinition.numId,
      abstractNumId: instanceDefinition.abstractNumId,
      levelStartOverrides: instanceDefinition.levelStartOverrides ? { ...instanceDefinition.levelStartOverrides } : void 0,
      levelOverrides: instanceDefinition.levelOverrides ? instanceDefinition.levelOverrides.map((level) => ({
        ...level,
        runStyle: level.runStyle ? { ...level.runStyle } : void 0,
        pictureBullet: level.pictureBullet ? { ...level.pictureBullet } : void 0
      })) : void 0
    }))
  };
}
function cloneDocModel(model) {
  return {
    nodes: model.nodes.map(cloneDocNode),
    metadata: {
      sourceParts: model.metadata.sourceParts,
      warnings: [...model.metadata.warnings],
      documentPageCount: model.metadata.documentPageCount,
      documentOpenTag: model.metadata.documentOpenTag,
      documentBackgroundColor: model.metadata.documentBackgroundColor,
      sectionPropertiesXml: model.metadata.sectionPropertiesXml,
      sections: model.metadata.sections?.map((section) => ({
        startNodeIndex: section.startNodeIndex,
        sectionPropertiesXml: section.sectionPropertiesXml,
        headerSections: (section.headerSections ?? []).map((headerSection) => ({
          partName: headerSection.partName,
          referenceType: headerSection.referenceType,
          nodes: headerSection.nodes.map(cloneDocNode)
        })),
        footerSections: (section.footerSections ?? []).map((footerSection) => ({
          partName: footerSection.partName,
          referenceType: footerSection.referenceType,
          nodes: footerSection.nodes.map(cloneDocNode)
        }))
      })),
      headerSections: (model.metadata.headerSections ?? []).map((section) => ({
        partName: section.partName,
        referenceType: section.referenceType,
        nodes: section.nodes.map(cloneDocNode)
      })),
      footerSections: (model.metadata.footerSections ?? []).map((section) => ({
        partName: section.partName,
        referenceType: section.referenceType,
        nodes: section.nodes.map(cloneDocNode)
      })),
      paragraphStyles: (model.metadata.paragraphStyles ?? []).map((style) => ({
        ...style,
        runStyle: style.runStyle ? { ...style.runStyle } : void 0,
        numbering: cloneParagraphNumbering(style.numbering),
        spacing: cloneParagraphSpacing(style.spacing),
        indent: cloneParagraphIndent(style.indent),
        borders: cloneParagraphBorderSet(style.borders)
      })),
      defaultParagraphStyleId: model.metadata.defaultParagraphStyleId,
      numberingDefinitions: cloneNumberingDefinitions(
        model.metadata.numberingDefinitions
      ),
      compatibility: model.metadata.compatibility ? { ...model.metadata.compatibility } : void 0,
      footnotes: model.metadata.footnotes?.map((note) => ({
        ...note,
        nodes: note.nodes?.map(cloneDocNode)
      })),
      endnotes: model.metadata.endnotes?.map((note) => ({
        ...note,
        nodes: note.nodes?.map(cloneDocNode)
      })),
      comments: model.metadata.comments?.map((comment) => ({ ...comment }))
    }
  };
}

// ../doc-model/src/index.ts
async function buildDocModel(pkg) {
  const wasmPackage = mapsToWasmPackage({
    parts: pkg.parts,
    binaryAssets: pkg.binaryAssets
  });
  const model = await wasmBuildDocModelFromPackage(wasmPackage);
  return normalizeDocModel(model);
}
async function buildDocModelFromBytes(bytes) {
  const { parseDocx } = await import("./src-2FP7IUE6.js");
  const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const buffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
  const pkg = await parseDocx(buffer);
  const model = await buildDocModel(pkg);
  return { package: pkg, model };
}

export {
  normalizeDocModel,
  cloneDocModel,
  buildDocModel,
  buildDocModelFromBytes
};
//# sourceMappingURL=chunk-P3MKA55V.js.map