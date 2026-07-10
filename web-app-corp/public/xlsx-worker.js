// src/charts.ts
import { strFromU8, strToU8 } from "fflate";
var CHART_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";
var CHART_EX_REL_TYPE = "http://schemas.microsoft.com/office/2014/relationships/chartEx";
var CHART_STYLE_REL_TYPE = "http://schemas.microsoft.com/office/2011/relationships/chartStyle";
var CHART_COLOR_STYLE_REL_TYPE = "http://schemas.microsoft.com/office/2011/relationships/chartColorStyle";
var SERIES_COLORS = [
  "#4472c4",
  "#ed7d31",
  "#a5a5a5",
  "#ffc000",
  "#5b9bd5",
  "#70ad47",
  "#264478",
  "#9e480e",
  "#636363",
  "#997300"
];
function normalizeWorksheetVisibility(value) {
  return value === "hidden" || value === "veryHidden" ? value : "visible";
}
var EMU_PER_PIXEL = 9525;
var THEME_COLOR_INDEX_BY_NAME = {
  accent1: 4,
  accent2: 5,
  accent3: 6,
  accent4: 7,
  accent5: 8,
  accent6: 9,
  dk1: 1,
  dk2: 3,
  folHlink: 11,
  hlink: 10,
  lt1: 0,
  lt2: 2,
  tx1: 1,
  tx2: 3,
  bg1: 0,
  bg2: 2
};
var PRIMARY_CHART_TYPE_LOCAL_NAMES = [
  "barChart",
  "lineChart",
  "line3DChart",
  "stockChart",
  "radarChart",
  "scatterChart",
  "pieChart",
  "pie3DChart",
  "doughnutChart",
  "areaChart",
  "area3DChart",
  "bar3DChart",
  "ofPieChart",
  "bubbleChart",
  "surfaceChart",
  "surface3DChart"
];
function clampUnitInterval(value) {
  return Math.max(0, Math.min(1, value));
}
function isElementNode(node) {
  return node != null && node.nodeType === 1;
}
function normalizeHexColor(value) {
  const hex = value.replace(/^#/, "");
  if (hex.length === 8) {
    return `#${hex.slice(2).toLowerCase()}`;
  }
  if (hex.length === 6) {
    return `#${hex.toLowerCase()}`;
  }
  return null;
}
function resolveColorFromXmlFragment(fragment, themePalette) {
  if (!fragment) {
    return void 0;
  }
  const srgbMatch = fragment.match(/<a:srgbClr\b[^>]*\bval="([0-9a-fA-F]{6,8})"/i);
  if (srgbMatch?.[1]) {
    return normalizeHexColor(srgbMatch[1]) ?? void 0;
  }
  const schemeMatch = fragment.match(/<a:schemeClr\b[^>]*\bval="([^"]+)"[^>]*>([\s\S]*?)<\/a:schemeClr>/i) ?? fragment.match(/<a:schemeClr\b[^>]*\bval="([^"]+)"[^>]*/i);
  if (!schemeMatch?.[1]) {
    return void 0;
  }
  const baseColor = resolveThemeColor(schemeMatch[1], themePalette);
  if (!baseColor) {
    return void 0;
  }
  const transforms = schemeMatch[2] ?? "";
  let lightnessModifier = 1;
  let lightnessOffset = 0;
  for (const match of transforms.matchAll(/<a:(lumMod|lumOff|tint|shade)\b[^>]*\bval="(-?\d+(?:\.\d+)?)"/gi)) {
    const transform = match[1]?.toLowerCase();
    const rawValue = Number(match[2] ?? Number.NaN);
    if (!transform || !Number.isFinite(rawValue)) {
      continue;
    }
    if (transform === "lummod") {
      lightnessModifier *= rawValue / 1e5;
    } else if (transform === "lumoff") {
      lightnessOffset += rawValue / 1e5;
    } else if (transform === "tint") {
      lightnessOffset += (1 - lightnessOffset) * (rawValue / 1e5);
    } else if (transform === "shade") {
      lightnessModifier *= rawValue / 1e5;
    }
  }
  return applyLightnessTransform(baseColor, lightnessModifier, lightnessOffset) ?? void 0;
}
function readHexColorFromXmlFragment(fragment, preferLine = false, themePalette) {
  const source = preferLine ? fragment.match(/<a:ln\b[\s\S]*?<\/a:ln>/i)?.[0] ?? "" : fragment.match(/<a:solidFill\b[\s\S]*?<\/a:solidFill>/i)?.[0] ?? "";
  return resolveColorFromXmlFragment(source, themePalette);
}
function parseFallbackSeriesStylesFromChartXml(chartXml, themePalette) {
  const seriesBlocks = chartXml.match(/<c:ser\b[\s\S]*?<\/c:ser>/gi) ?? [];
  if (seriesBlocks.length === 0) {
    return [];
  }
  return seriesBlocks.map((seriesBlock) => {
    const shapeBlock = seriesBlock.match(/<c:spPr\b[\s\S]*?<\/c:spPr>/i)?.[0] ?? "";
    return {
      color: readHexColorFromXmlFragment(shapeBlock, false, themePalette),
      lineColor: readHexColorFromXmlFragment(shapeBlock, true, themePalette)
    };
  });
}
function parseFallbackPointStylesFromChartXml(chartXml, themePalette) {
  const chartDocument = parseXml(chartXml);
  if (chartDocument) {
    const parsedSeriesStyles = getLocalDescendants(chartDocument, "ser").map((seriesNode) => {
      const styles = [];
      for (const dataPointNode of getLocalChildren(seriesNode, "dPt")) {
        const indexValue = readChartNumericAttribute(dataPointNode, "idx");
        if (indexValue === void 0) {
          continue;
        }
        const shapeProperties = getFirstLocalChild(dataPointNode, "spPr");
        const lineStyle = resolveChartLineStyle(shapeProperties, themePalette);
        styles.push({
          color: resolveChartFillColor(shapeProperties, themePalette) ?? void 0,
          explosion: readChartNumericAttribute(dataPointNode, "explosion"),
          index: indexValue,
          lineColor: lineStyle.color ?? void 0
        });
      }
      return styles;
    });
    if (parsedSeriesStyles.some((styles) => styles.length > 0)) {
      return parsedSeriesStyles;
    }
  }
  const seriesBlocks = chartXml.match(/<c:ser\b[\s\S]*?<\/c:ser>/gi) ?? [];
  if (seriesBlocks.length === 0) {
    return [];
  }
  return seriesBlocks.map((seriesBlock) => {
    const pointBlocks = seriesBlock.match(/<c:dPt\b[\s\S]*?<\/c:dPt>/gi) ?? [];
    if (pointBlocks.length === 0) {
      return [];
    }
    const styles = [];
    for (const pointBlock of pointBlocks) {
      const indexMatch = pointBlock.match(/<c:idx\b[^>]*\bval="(-?\d+)"/i);
      const index = indexMatch?.[1] ? Number(indexMatch[1]) : Number.NaN;
      if (!Number.isFinite(index)) {
        continue;
      }
      const explosionMatch = pointBlock.match(/<c:explosion\b[^>]*\bval="(-?\d+(?:\.\d+)?)"/i);
      const explosionValue = explosionMatch?.[1] ? Number(explosionMatch[1]) : Number.NaN;
      styles.push({
        color: readHexColorFromXmlFragment(pointBlock, false, themePalette),
        explosion: Number.isFinite(explosionValue) ? explosionValue : void 0,
        index,
        lineColor: readHexColorFromXmlFragment(pointBlock, true, themePalette)
      });
    }
    return styles;
  });
}
function parseNumericPointCacheFromXmlFragment(fragment) {
  const pointMatches = Array.from(fragment.matchAll(/<c:pt\b[^>]*\bidx="(-?\d+)"[^>]*>[\s\S]*?<c:v>([^<]*)<\/c:v>[\s\S]*?<\/c:pt>/gi));
  if (pointMatches.length === 0) {
    return [];
  }
  const explicitPointCountMatch = fragment.match(/<c:ptCount\b[^>]*\bval="(\d+)"/i);
  const explicitPointCount = explicitPointCountMatch?.[1] ? Number(explicitPointCountMatch[1]) : Number.NaN;
  const maxIndex = pointMatches.reduce((max, match) => {
    const current = Number(match[1] ?? Number.NaN);
    return Number.isFinite(current) ? Math.max(max, current) : max;
  }, -1);
  const pointCount = Math.max(
    pointMatches.length,
    Number.isFinite(explicitPointCount) ? explicitPointCount : 0,
    maxIndex + 1
  );
  const values = Array.from({ length: pointCount }, () => null);
  for (const match of pointMatches) {
    const index = Number(match[1] ?? Number.NaN);
    const rawValue = (match[2] ?? "").trim();
    const numericValue = Number(rawValue);
    if (!Number.isFinite(index) || index < 0 || !Number.isFinite(numericValue)) {
      continue;
    }
    values[index] = numericValue;
  }
  return values;
}
function parseFallbackBubbleSizesFromChartXml(chartXml) {
  const seriesBlocks = chartXml.match(/<c:ser\b[\s\S]*?<\/c:ser>/gi) ?? [];
  if (seriesBlocks.length === 0) {
    return [];
  }
  return seriesBlocks.map((seriesBlock) => {
    const bubbleSizeBlock = seriesBlock.match(/<c:bubbleSize\b[\s\S]*?<\/c:bubbleSize>/i)?.[0] ?? "";
    if (!bubbleSizeBlock) {
      return [];
    }
    return parseNumericPointCacheFromXmlFragment(bubbleSizeBlock);
  });
}
function decodeChartXmlText(value) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
function normalizeChartTitleForMatch(value) {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}
function extractChartTitleFromXml(chartXml) {
  const match = chartXml.match(/<c:title\b[\s\S]*?<a:t>([\s\S]*?)<\/a:t>/i);
  if (!match?.[1]) {
    return null;
  }
  const decoded = decodeChartXmlText(match[1]).trim();
  return decoded.length > 0 ? decoded : null;
}
function resolveArchiveFallbackBubbleSizes(archive, preferredTitle) {
  const preferred = normalizeChartTitleForMatch(preferredTitle);
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestCandidate = [];
  for (const [path, bytes] of Object.entries(archive)) {
    if (!/\/charts\/chart\d+\.xml$/i.test(path)) {
      continue;
    }
    const chartXml = strFromU8(bytes);
    if (!/<c:bubbleChart\b/i.test(chartXml)) {
      continue;
    }
    const candidateBubbleSizes = parseFallbackBubbleSizesFromChartXml(chartXml);
    const hasCandidateValues = candidateBubbleSizes.some((seriesValues) => seriesValues.some((value) => value != null));
    if (!hasCandidateValues) {
      continue;
    }
    let score = 0;
    const candidateTitle = normalizeChartTitleForMatch(extractChartTitleFromXml(chartXml));
    if (preferred.length > 0 && candidateTitle.length > 0 && preferred === candidateTitle) {
      score += 100;
    }
    if (bestCandidate.length === 0) {
      score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidateBubbleSizes;
      if (score >= 100) {
        break;
      }
    }
  }
  return bestCandidate;
}
function parseChartTypeFromXml(chartXml) {
  for (const chartType of PRIMARY_CHART_TYPE_LOCAL_NAMES) {
    if (new RegExp(`<c:${chartType}\\b`, "i").test(chartXml)) {
      return chartType;
    }
  }
  return "";
}
function findPrimaryChartTypeNode(plotAreaNode) {
  if (!plotAreaNode) {
    return null;
  }
  for (const localName of PRIMARY_CHART_TYPE_LOCAL_NAMES) {
    const node = getLocalChildren(plotAreaNode, localName)[0];
    if (node) {
      return node;
    }
  }
  return null;
}
function resolveScatterChartType(scatterStyle) {
  switch (scatterStyle) {
    case "line":
    case "lineMarker":
      return "ScatterLines";
    case "smooth":
    case "smoothMarker":
      return "ScatterSmooth";
    default:
      return "Scatter";
  }
}
function resolveArchiveFallbackPointStyles(archive, preferredTitle, preferredChartXmlType, themePalette) {
  const preferred = normalizeChartTitleForMatch(preferredTitle);
  const preferredType = (preferredChartXmlType ?? "").trim();
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestCandidate = [];
  for (const [path, bytes] of Object.entries(archive)) {
    if (!/\/charts\/chart\d+\.xml$/i.test(path)) {
      continue;
    }
    const chartXml = strFromU8(bytes);
    const candidateType = parseChartTypeFromXml(chartXml);
    if (!candidateType) {
      continue;
    }
    const candidatePointStyles = parseFallbackPointStylesFromChartXml(chartXml, themePalette);
    const hasCandidateValues = candidatePointStyles.some((seriesStyles) => seriesStyles.some((style) => typeof style.color === "string" && style.color.length > 0 || typeof style.explosion === "number"));
    if (!hasCandidateValues) {
      continue;
    }
    let score = 0;
    const candidateTitle = normalizeChartTitleForMatch(extractChartTitleFromXml(chartXml));
    if (preferred.length > 0 && candidateTitle.length > 0 && preferred === candidateTitle) {
      score += 100;
    }
    if (preferredType && candidateType === preferredType) {
      score += 20;
    }
    if (bestCandidate.length === 0) {
      score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidatePointStyles;
      if (score >= 120) {
        break;
      }
    }
  }
  return bestCandidate;
}
function parseHexColor(color) {
  const normalized = normalizeHexColor(color);
  if (!normalized) {
    return null;
  }
  const match = /^#([0-9a-f]{6})$/.exec(normalized);
  if (!match) {
    return null;
  }
  return [
    Number.parseInt(match[1].slice(0, 2), 16),
    Number.parseInt(match[1].slice(2, 4), 16),
    Number.parseInt(match[1].slice(4, 6), 16)
  ];
}
function rgbToHsl(red, green, blue) {
  const normalizedRed = red / 255;
  const normalizedGreen = green / 255;
  const normalizedBlue = blue / 255;
  const max = Math.max(normalizedRed, normalizedGreen, normalizedBlue);
  const min = Math.min(normalizedRed, normalizedGreen, normalizedBlue);
  const lightness = (max + min) / 2;
  if (max === min) {
    return [0, 0, lightness];
  }
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;
  switch (max) {
    case normalizedRed:
      hue = (normalizedGreen - normalizedBlue) / delta + (normalizedGreen < normalizedBlue ? 6 : 0);
      break;
    case normalizedGreen:
      hue = (normalizedBlue - normalizedRed) / delta + 2;
      break;
    default:
      hue = (normalizedRed - normalizedGreen) / delta + 4;
      break;
  }
  return [hue / 6, saturation, lightness];
}
function hueToRgb(p, q, t) {
  let nextT = t;
  if (nextT < 0) {
    nextT += 1;
  }
  if (nextT > 1) {
    nextT -= 1;
  }
  if (nextT < 1 / 6) {
    return p + (q - p) * 6 * nextT;
  }
  if (nextT < 1 / 2) {
    return q;
  }
  if (nextT < 2 / 3) {
    return p + (q - p) * (2 / 3 - nextT) * 6;
  }
  return p;
}
function hslToRgb(hue, saturation, lightness) {
  if (saturation === 0) {
    const gray = Math.round(lightness * 255);
    return [gray, gray, gray];
  }
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return [
    Math.round(hueToRgb(p, q, hue + 1 / 3) * 255),
    Math.round(hueToRgb(p, q, hue) * 255),
    Math.round(hueToRgb(p, q, hue - 1 / 3) * 255)
  ];
}
function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0")).join("")}`;
}
function applyLightnessTransform(baseColor, modifier = 1, offset = 0) {
  const rgb = parseHexColor(baseColor);
  if (!rgb) {
    return normalizeHexColor(baseColor);
  }
  const [hue, saturation, lightness] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  const nextLightness = clampUnitInterval(lightness * modifier + offset);
  const [nextRed, nextGreen, nextBlue] = hslToRgb(hue, saturation, nextLightness);
  return rgbToHex(nextRed, nextGreen, nextBlue);
}
function resolveThemeColor(name, themePalette) {
  if (!name) {
    return null;
  }
  const index = THEME_COLOR_INDEX_BY_NAME[name];
  return index === void 0 ? null : themePalette?.colorsByIndex[index] ?? null;
}
function resolveThemeTypeface(typeface, themePalette) {
  if (!typeface) {
    return null;
  }
  if (typeface === "+mn-lt" || typeface === "+mn-ea" || typeface === "+mn-cs") {
    return themePalette?.minorLatinFont ?? null;
  }
  if (typeface === "+mj-lt" || typeface === "+mj-ea" || typeface === "+mj-cs") {
    return themePalette?.majorLatinFont ?? null;
  }
  return typeface;
}
function readChartTextTypeface(textPropertiesNode, themePalette) {
  if (!textPropertiesNode) {
    return null;
  }
  const defaultRunProperties = getFirstLocalDescendant(textPropertiesNode, "defRPr") ?? getFirstLocalDescendant(textPropertiesNode, "rPr");
  if (!defaultRunProperties) {
    return null;
  }
  const typeface = getFirstLocalChild(defaultRunProperties, "latin")?.getAttribute("typeface") ?? getFirstLocalChild(defaultRunProperties, "ea")?.getAttribute("typeface") ?? getFirstLocalChild(defaultRunProperties, "cs")?.getAttribute("typeface") ?? null;
  const resolved = resolveThemeTypeface(typeface, themePalette)?.trim() ?? "";
  return resolved.length > 0 ? resolved : null;
}
function resolveChartColorNode(node, themePalette) {
  if (!node) {
    return null;
  }
  let baseColor = null;
  if (node.localName === "srgbClr") {
    baseColor = normalizeHexColor(`#${node.getAttribute("val") ?? ""}`);
  } else if (node.localName === "schemeClr") {
    baseColor = resolveThemeColor(node.getAttribute("val"), themePalette);
  } else if (node.localName === "sysClr") {
    baseColor = normalizeHexColor(`#${node.getAttribute("lastClr") ?? ""}`);
  }
  if (!baseColor) {
    return null;
  }
  let lightnessModifier = 1;
  let lightnessOffset = 0;
  for (const transformNode of Array.from(node.childNodes).filter(isElementNode)) {
    const rawValue = Number(transformNode.getAttribute("val") ?? Number.NaN);
    if (!Number.isFinite(rawValue)) {
      continue;
    }
    if (transformNode.localName === "lumMod") {
      lightnessModifier *= rawValue / 1e5;
    } else if (transformNode.localName === "lumOff") {
      lightnessOffset += rawValue / 1e5;
    } else if (transformNode.localName === "tint") {
      lightnessOffset += (1 - lightnessOffset) * (rawValue / 1e5);
    } else if (transformNode.localName === "shade") {
      lightnessModifier *= rawValue / 1e5;
    }
  }
  return applyLightnessTransform(baseColor, lightnessModifier, lightnessOffset);
}
function isChartColorElement(node) {
  return Boolean(node && (node.localName === "schemeClr" || node.localName === "srgbClr" || node.localName === "sysClr"));
}
function findFirstChartColorElement(node) {
  if (!node) {
    return null;
  }
  if (isChartColorElement(node)) {
    return node;
  }
  for (const localName of ["srgbClr", "schemeClr", "sysClr"]) {
    for (const candidate of getLocalDescendants(node, localName)) {
      if (isChartColorElement(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}
function resolveChartFillColor(shapeNode, themePalette) {
  if (!shapeNode || getFirstLocalChild(shapeNode, "noFill")) {
    return null;
  }
  const solidFill = getFirstLocalChild(shapeNode, "solidFill");
  if (solidFill) {
    const colorNode = findFirstChartColorElement(Array.from(solidFill.childNodes).find(isElementNode) ?? null);
    return resolveChartColorNode(colorNode, themePalette);
  }
  const gradientFill = getFirstLocalChild(shapeNode, "gradFill");
  const gradientStops = gradientFill ? getLocalDescendants(gradientFill, "gs").map((stopNode) => ({
    colorNode: Array.from(stopNode.childNodes).find(isElementNode) ?? null,
    position: Number(stopNode.getAttribute("pos") ?? Number.NaN)
  })).filter((stop) => Boolean(stop.colorNode)) : [];
  if (gradientStops.length === 0) {
    return null;
  }
  gradientStops.sort((left, right) => {
    const leftPos = Number.isFinite(left.position) ? left.position : 0;
    const rightPos = Number.isFinite(right.position) ? right.position : 0;
    return leftPos - rightPos;
  });
  const midpointStop = gradientStops.find((stop) => Number.isFinite(stop.position) && stop.position >= 5e4) ?? gradientStops[Math.floor(gradientStops.length / 2)] ?? gradientStops[0];
  return resolveChartColorNode(midpointStop.colorNode, themePalette);
}
function resolveChartLineStyle(shapeNode, themePalette) {
  const lineNode = shapeNode?.localName === "ln" ? shapeNode : shapeNode ? getFirstLocalChild(shapeNode, "ln") : null;
  if (!lineNode) {
    return { color: null, hidden: false, widthPx: void 0 };
  }
  if (getFirstLocalChild(lineNode, "noFill")) {
    return { color: null, hidden: true, widthPx: void 0 };
  }
  const solidFill = getFirstLocalChild(lineNode, "solidFill");
  const colorNode = solidFill ? findFirstChartColorElement(Array.from(solidFill.childNodes).find(isElementNode) ?? null) : null;
  const widthValue = Number(lineNode.getAttribute("w") ?? Number.NaN);
  return {
    color: resolveChartColorNode(colorNode, themePalette),
    hidden: false,
    widthPx: Number.isFinite(widthValue) ? Math.max(1, widthValue / EMU_PER_PIXEL) : void 0
  };
}
function normalizeLegend(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const legend = raw;
  return {
    overlay: typeof legend.overlay === "boolean" ? legend.overlay : void 0,
    position: typeof legend.position === "string" ? legend.position : void 0,
    raw: legend
  };
}
function normalizeLegendPosition(position) {
  if (!position) {
    return void 0;
  }
  switch (position) {
    case "bottom":
      return "b";
    case "left":
      return "l";
    case "right":
      return "r";
    case "top":
      return "t";
    default:
      return position;
  }
}
function readChartNumericAttribute(parent, localName) {
  const node = parent ? getFirstLocalChild(parent, localName) : null;
  const value = Number(node?.getAttribute("val") ?? Number.NaN);
  return Number.isFinite(value) ? value : void 0;
}
function readChartBooleanAttribute(parent, localName) {
  const node = parent ? getFirstLocalChild(parent, localName) : null;
  if (!node) {
    return void 0;
  }
  const rawValue = node.getAttribute("val");
  if (rawValue == null) {
    return true;
  }
  if (rawValue === "1" || rawValue === "true") {
    return true;
  }
  if (rawValue === "0" || rawValue === "false") {
    return false;
  }
  return void 0;
}
function readChartLabelFontSizePt(textPropertiesNode) {
  if (!textPropertiesNode) {
    return void 0;
  }
  const runPropertiesNode = getFirstLocalDescendant(textPropertiesNode, "defRPr") ?? getFirstLocalDescendant(textPropertiesNode, "rPr");
  const rawSize = Number(runPropertiesNode?.getAttribute("sz") ?? Number.NaN);
  if (!Number.isFinite(rawSize) || rawSize <= 0) {
    return void 0;
  }
  return rawSize / 100;
}
function parseChartPointDataLabelsFromXml(labelsNode) {
  const fallbackFontSizePt = readChartLabelFontSizePt(getFirstLocalChild(labelsNode, "txPr"));
  const labels = [];
  for (const pointLabelNode of getLocalChildren(labelsNode, "dLbl")) {
    const index = readChartNumericAttribute(pointLabelNode, "idx");
    if (typeof index !== "number" || !Number.isFinite(index)) {
      continue;
    }
    const layoutNode = getFirstLocalChild(pointLabelNode, "layout");
    const manualLayoutNode = getFirstLocalChild(layoutNode, "manualLayout");
    labels.push({
      deleted: readChartBooleanAttribute(pointLabelNode, "delete"),
      fontSizePt: readChartLabelFontSizePt(getFirstLocalChild(pointLabelNode, "txPr")) ?? fallbackFontSizePt,
      index,
      showBubbleSize: readChartBooleanAttribute(pointLabelNode, "showBubbleSize"),
      showCategoryName: readChartBooleanAttribute(pointLabelNode, "showCatName"),
      showPercent: readChartBooleanAttribute(pointLabelNode, "showPercent"),
      showSeriesName: readChartBooleanAttribute(pointLabelNode, "showSerName"),
      showValue: readChartBooleanAttribute(pointLabelNode, "showVal"),
      x: readChartNumericAttribute(manualLayoutNode, "x"),
      y: readChartNumericAttribute(manualLayoutNode, "y")
    });
  }
  return labels;
}
function parseChartDataLabelsFromXml(labelsNode) {
  if (!labelsNode) {
    return null;
  }
  const pointLabels = parseChartPointDataLabelsFromXml(labelsNode);
  const labels = {
    pointLabels: pointLabels.length > 0 ? pointLabels : void 0,
    raw: {},
    showBubbleSize: readChartBooleanAttribute(labelsNode, "showBubbleSize"),
    showCategoryName: readChartBooleanAttribute(labelsNode, "showCatName"),
    showLegendKey: readChartBooleanAttribute(labelsNode, "showLegendKey"),
    showPercent: readChartBooleanAttribute(labelsNode, "showPercent"),
    showSeriesName: readChartBooleanAttribute(labelsNode, "showSerName"),
    showValue: readChartBooleanAttribute(labelsNode, "showVal")
  };
  const hasValue = labels.showBubbleSize !== void 0 || labels.showCategoryName !== void 0 || labels.showLegendKey !== void 0 || labels.showPercent !== void 0 || (labels.pointLabels?.length ?? 0) > 0 || labels.showSeriesName !== void 0 || labels.showValue !== void 0;
  return hasValue ? labels : null;
}
function readChartRelationships(archive, chartPath) {
  const relsPath = normalizeArchivePath(`${dirname(chartPath)}/_rels/${chartPath.split("/").pop()}.rels`);
  const relsXml = readArchiveText(archive, relsPath);
  if (!relsXml) {
    return /* @__PURE__ */ new Map();
  }
  const relsDocument = parseXml(relsXml);
  if (!relsDocument) {
    return /* @__PURE__ */ new Map();
  }
  const relationships = /* @__PURE__ */ new Map();
  for (const relationshipNode of getLocalDescendants(relsDocument, "Relationship")) {
    const type = relationshipNode.getAttribute("Type");
    const target = relationshipNode.getAttribute("Target");
    if (!type || !target) {
      continue;
    }
    relationships.set(type, resolveRelationshipPath(relsPath, target));
  }
  return relationships;
}
function readChartColorPalette(archive, colorStylePath, themePalette) {
  const colorStyleXml = readArchiveText(archive, colorStylePath);
  if (!colorStyleXml) {
    return [];
  }
  const colorStyleDocument = parseXml(colorStyleXml);
  if (!colorStyleDocument?.documentElement) {
    return [];
  }
  return Array.from(colorStyleDocument.documentElement.childNodes).filter((child) => isElementNode(child) && child.localName !== "variation").map((child) => resolveChartColorNode(child, themePalette) ?? resolveChartColorNode(findFirstChartColorElement(child), themePalette)).filter((color) => typeof color === "string");
}
function readChartStyleAppearance(archive, stylePath, themePalette) {
  const styleXml = readArchiveText(archive, stylePath);
  if (!styleXml) {
    return {};
  }
  const styleDocument = parseXml(styleXml);
  if (!styleDocument) {
    return {};
  }
  const dataPointNode = getFirstLocalDescendant(styleDocument, "dataPoint");
  const fillRefNode = dataPointNode ? getFirstLocalChild(dataPointNode, "fillRef") : null;
  const index = Number(fillRefNode?.getAttribute("idx") ?? Number.NaN);
  const chartAreaNode = getFirstLocalDescendant(styleDocument, "chartArea");
  const chartAreaShapeProperties = chartAreaNode ? getFirstLocalChild(chartAreaNode, "spPr") : null;
  const chartAreaFontRef = chartAreaNode ? getFirstLocalChild(chartAreaNode, "fontRef") : null;
  const chartAreaFontColor = chartAreaFontRef ? resolveChartColorNode(Array.from(chartAreaFontRef.childNodes).find(isElementNode) ?? null, themePalette) : null;
  const titleNode = getFirstLocalDescendant(styleDocument, "title");
  const titleFontRef = titleNode ? getFirstLocalChild(titleNode, "fontRef") : null;
  const titleColor = titleFontRef ? resolveChartColorNode(Array.from(titleFontRef.childNodes).find(isElementNode) ?? null, themePalette) : null;
  const axisStyleNode = getFirstLocalDescendant(styleDocument, "categoryAxis") ?? getFirstLocalDescendant(styleDocument, "valueAxis");
  const axisShapeProperties = axisStyleNode ? getFirstLocalChild(axisStyleNode, "spPr") : null;
  const axisFontRef = axisStyleNode ? getFirstLocalChild(axisStyleNode, "fontRef") : null;
  const chartAreaNoFill = chartAreaShapeProperties ? getFirstLocalChild(chartAreaShapeProperties, "noFill") != null : false;
  return {
    axisLabelColor: axisFontRef ? resolveChartColorNode(Array.from(axisFontRef.childNodes).find(isElementNode) ?? null, themePalette) ?? void 0 : void 0,
    axisLineColor: resolveChartLineStyle(axisShapeProperties, themePalette).color ?? void 0,
    chartAreaBorderColor: resolveChartLineStyle(chartAreaShapeProperties, themePalette).color ?? void 0,
    chartAreaFillColor: resolveChartFillColor(chartAreaShapeProperties, themePalette) ?? void 0,
    chartAreaNoFill,
    paletteOffset: Number.isFinite(index) ? index : void 0,
    textColor: chartAreaFontColor ?? void 0,
    titleColor: titleColor ?? chartAreaFontColor ?? void 0
  };
}
function buildThemeSeriesPalette(themePalette) {
  const themeColors = [4, 5, 6, 7, 8, 9].map((index) => themePalette?.colorsByIndex[index] ?? null).filter((color) => Boolean(color));
  return themeColors.length > 0 ? themeColors : SERIES_COLORS;
}
function normalizeBuiltinSurfaceStyleId(styleId) {
  if (typeof styleId !== "number" || !Number.isFinite(styleId)) {
    return null;
  }
  return styleId >= 100 ? styleId - 100 : styleId;
}
function getBuiltinSurfacePalette(styleId, wireframe) {
  const normalized = normalizeBuiltinSurfaceStyleId(styleId);
  if (normalized === 34 || wireframe === true && normalized == null) {
    return ["#5b9bd5", "#ed7d31", "#a5a5a5"];
  }
  if (normalized === 35 || normalized === 36 || wireframe !== true && normalized == null) {
    return ["#2f5597", "#4472c4", "#5b9bd5", "#8faadc", "#d9e2f3"];
  }
  return null;
}
function applyBuiltinSurfaceDefaults(chart) {
  if (chart.chartType !== "Surface") {
    return;
  }
  const builtinPalette = getBuiltinSurfacePalette(chart.chartStyleId, chart.wireframe);
  if ((!chart.chartColorPalette || chart.chartColorPalette.length === 0) && builtinPalette) {
    chart.chartColorPalette = builtinPalette;
  }
  const wallFill = chart.wireframe ? "#d0d0d0" : "#d9d9df";
  const wallLine = chart.wireframe ? "#a6a6a6" : "#a8adb7";
  chart.floor = {
    ...chart.floor ?? {},
    fillColor: chart.floor?.fillColor ?? wallFill,
    lineColor: chart.floor?.lineColor ?? wallLine
  };
  chart.sideWall = {
    ...chart.sideWall ?? {},
    fillColor: chart.sideWall?.fillColor ?? wallFill,
    lineColor: chart.sideWall?.lineColor ?? wallLine
  };
  chart.backWall = {
    ...chart.backWall ?? {},
    fillColor: chart.backWall?.fillColor ?? wallFill,
    lineColor: chart.backWall?.lineColor ?? wallLine
  };
  if (!chart.surfaceMaterial && chart.wireframe !== true) {
    chart.surfaceMaterial = "flat";
  }
}
function applyBuiltinChartDefaults(chart, themePalette) {
  const darkBuiltInStyle = typeof chart.chartStyleId === "number" && chart.chartStyleId >= 140 && chart.chartStyleId < 150;
  const textColor = themePalette?.colorsByIndex[1] ?? themePalette?.colorsByIndex[3] ?? null;
  const minorTypeface = themePalette?.minorLatinFont?.trim() || void 0;
  const derivedAxisColor = textColor ? applyLightnessTransform(textColor, 0.35, 0.55) : null;
  const derivedBorderColor = textColor ? applyLightnessTransform(textColor, chart.is3d ? 0.28 : 0.22, chart.is3d ? 0.6 : 0.7) : null;
  if (darkBuiltInStyle) {
    chart.chartAreaFillColor = chart.chartAreaFillColor ?? "#1f1f1f";
    chart.chartAreaBorderColor = chart.chartAreaBorderColor ?? "#1f1f1f";
    chart.textColor = chart.textColor ?? "#f5f5f5";
    chart.titleColor = chart.titleColor ?? "#f5f5f5";
    chart.axisLabelColor = chart.axisLabelColor ?? "#d9d9d9";
    chart.axisLineColor = chart.axisLineColor ?? "#8c8c8c";
  }
  chart.chartAreaBorderColor = chart.chartAreaBorderColor ?? derivedBorderColor ?? void 0;
  chart.textColor = chart.textColor ?? textColor ?? void 0;
  chart.titleColor = chart.titleColor ?? textColor ?? void 0;
  chart.axisLabelColor = chart.axisLabelColor ?? derivedAxisColor ?? textColor ?? void 0;
  chart.axisLineColor = chart.axisLineColor ?? derivedAxisColor ?? textColor ?? void 0;
  chart.fontFamily = chart.fontFamily ?? minorTypeface;
  chart.titleFontFamily = chart.titleFontFamily ?? chart.fontFamily ?? minorTypeface;
  const seriesPalette = chart.chartColorPalette && chart.chartColorPalette.length > 0 ? chart.chartColorPalette : buildThemeSeriesPalette(themePalette);
  if (!chart.chartColorPalette || chart.chartColorPalette.length === 0) {
    chart.chartColorPalette = seriesPalette;
  }
  chart.series = chart.series.map((series, index) => {
    const fallbackColor = seriesPalette[index % seriesPalette.length];
    return {
      ...series,
      color: series.color ?? series.lineColor ?? fallbackColor,
      lineColor: series.lineColor ?? series.color ?? fallbackColor,
      markerColor: series.markerColor ?? series.color ?? series.lineColor ?? fallbackColor,
      markerLineColor: series.markerLineColor ?? series.lineColor ?? series.color ?? fallbackColor
    };
  });
  chart.typeGroups = chart.typeGroups?.map((group, groupIndex) => ({
    ...group,
    series: group.series.map((series, seriesIndex) => {
      const fallbackColor = seriesPalette[(groupIndex + seriesIndex) % seriesPalette.length];
      return {
        ...series,
        color: series.color ?? series.lineColor ?? fallbackColor,
        lineColor: series.lineColor ?? series.color ?? fallbackColor,
        markerColor: series.markerColor ?? series.color ?? series.lineColor ?? fallbackColor,
        markerLineColor: series.markerLineColor ?? series.lineColor ?? series.color ?? fallbackColor
      };
    })
  }));
  applyBuiltinSurfaceDefaults(chart);
}
function parseChartPointStyles(seriesNode, themePalette) {
  const pointStyles = [];
  for (const dataPointNode of getLocalChildren(seriesNode, "dPt")) {
    const indexValue = readChartNumericAttribute(dataPointNode, "idx");
    if (indexValue === void 0) {
      continue;
    }
    const shapeProperties = getFirstLocalChild(dataPointNode, "spPr");
    const lineStyle = resolveChartLineStyle(shapeProperties, themePalette);
    pointStyles.push({
      color: resolveChartFillColor(shapeProperties, themePalette) ?? void 0,
      explosion: readChartNumericAttribute(dataPointNode, "explosion"),
      index: indexValue,
      lineColor: lineStyle.color ?? void 0
    });
  }
  return pointStyles;
}
function parseInvertNegativeStyle(seriesNode, themePalette) {
  const invertNode = getFirstLocalDescendant(seriesNode, "invertSolidFillFmt");
  const shapeProperties = invertNode ? getFirstLocalChild(invertNode, "spPr") : null;
  if (!shapeProperties) {
    return {
      color: void 0,
      lineColor: void 0
    };
  }
  const lineStyle = resolveChartLineStyle(shapeProperties, themePalette);
  return {
    color: resolveChartFillColor(shapeProperties, themePalette) ?? void 0,
    lineColor: lineStyle.color ?? void 0
  };
}
function parseChartCacheValues(parentNode, cacheName, mode) {
  if (!parentNode) {
    return null;
  }
  const referenceNode = getFirstLocalChild(parentNode, "numRef") ?? getFirstLocalChild(parentNode, "strRef") ?? parentNode;
  const cacheNode = getFirstLocalChild(referenceNode, cacheName);
  if (!cacheNode) {
    return null;
  }
  const pointCount = readChartNumericAttribute(cacheNode, "ptCount");
  const pointNodes = getLocalChildren(cacheNode, "pt").map((pointNode) => {
    const rawIndex = Number(pointNode.getAttribute("idx") ?? Number.NaN);
    return {
      index: Number.isFinite(rawIndex) ? rawIndex : 0,
      value: getFirstLocalChild(pointNode, "v")?.textContent ?? ""
    };
  }).sort((left, right) => left.index - right.index);
  if (pointNodes.length === 0) {
    return null;
  }
  const maxIndex = pointNodes.reduce((max, point) => Math.max(max, point.index), 0);
  const targetLength = Math.max(
    pointNodes.length,
    Number.isFinite(pointCount ?? Number.NaN) ? Number(pointCount) : 0,
    maxIndex + 1
  );
  const values = Array.from({ length: targetLength }, () => null);
  for (const point of pointNodes) {
    if (mode === "value") {
      values[point.index] = cellValueToNumber(point.value);
    } else {
      values[point.index] = point.value.length > 0 ? point.value : null;
    }
  }
  return values;
}
function parseChartMultiLevelCacheValues(parentNode, mode) {
  if (!parentNode) {
    return null;
  }
  const referenceNode = getFirstLocalChild(parentNode, "multiLvlStrRef") ?? parentNode;
  const cacheNode = getFirstLocalChild(referenceNode, "multiLvlStrCache");
  if (!cacheNode) {
    return null;
  }
  const levelNodes = getLocalChildren(cacheNode, "lvl");
  if (levelNodes.length === 0) {
    return null;
  }
  const pointCount = readChartNumericAttribute(cacheNode, "ptCount");
  const primaryLevelNode = mode === "category" ? levelNodes[levelNodes.length - 1] ?? levelNodes[0] : levelNodes[0];
  const pointNodes = getLocalChildren(primaryLevelNode, "pt").map((pointNode) => {
    const rawIndex = Number(pointNode.getAttribute("idx") ?? Number.NaN);
    return {
      index: Number.isFinite(rawIndex) ? rawIndex : 0,
      value: getFirstLocalChild(pointNode, "v")?.textContent ?? ""
    };
  }).sort((left, right) => left.index - right.index);
  if (pointNodes.length === 0) {
    return null;
  }
  const maxIndex = pointNodes.reduce((max, point) => Math.max(max, point.index), 0);
  const targetLength = Math.max(
    pointNodes.length,
    Number.isFinite(pointCount ?? Number.NaN) ? Number(pointCount) : 0,
    maxIndex + 1
  );
  const values = Array.from({ length: targetLength }, () => null);
  for (const point of pointNodes) {
    if (mode === "value") {
      values[point.index] = cellValueToNumber(point.value);
      continue;
    }
    values[point.index] = point.value.length > 0 ? point.value : null;
  }
  return values;
}
function applyChartSeriesStyleFromXml(chart, chartTypeNode, themePalette) {
  const seriesNodes = getLocalChildren(chartTypeNode, "ser");
  chart.series = chart.series.map((series, index) => {
    const seriesNode = seriesNodes[index];
    if (!seriesNode) {
      return series;
    }
    const shapeProperties = getFirstLocalChild(seriesNode, "spPr");
    const markerNode = getFirstLocalChild(seriesNode, "marker");
    const markerShapeProperties = getFirstLocalChild(markerNode ?? chartTypeNode, "spPr");
    const lineStyle = resolveChartLineStyle(shapeProperties, themePalette);
    const markerLineStyle = resolveChartLineStyle(markerShapeProperties, themePalette);
    const fillColor = resolveChartFillColor(shapeProperties, themePalette);
    const markerSize = readChartNumericAttribute(markerNode, "size");
    const markerSymbolNode = markerNode ? getFirstLocalChild(markerNode, "symbol") : null;
    const markerSymbol = markerSymbolNode?.getAttribute("val") ?? void 0;
    const pointStyles = parseChartPointStyles(seriesNode, themePalette);
    const seriesExplosion = readChartNumericAttribute(seriesNode, "explosion");
    const invertNegativeStyle = parseInvertNegativeStyle(seriesNode, themePalette);
    const invertIfNegative = readChartBooleanAttribute(seriesNode, "invertIfNegative");
    const isScatterChart = chart.chartType === "Scatter" || chart.chartType === "ScatterLines" || chart.chartType === "ScatterSmooth" || chart.chartType === "Bubble";
    const cachedCategories = isScatterChart ? parseChartCacheValues(getFirstLocalChild(seriesNode, "xVal"), "numCache", "value") ?? parseChartMultiLevelCacheValues(getFirstLocalChild(seriesNode, "xVal"), "category") : parseChartCacheValues(getFirstLocalChild(seriesNode, "cat"), "strCache", "category") ?? parseChartCacheValues(getFirstLocalChild(seriesNode, "cat"), "numCache", "category") ?? parseChartMultiLevelCacheValues(getFirstLocalChild(seriesNode, "cat"), "category");
    const cachedValues = isScatterChart ? parseChartCacheValues(getFirstLocalChild(seriesNode, "yVal"), "numCache", "value") : parseChartCacheValues(getFirstLocalChild(seriesNode, "val"), "numCache", "value");
    const cachedBubbleSizes = chart.chartType === "Bubble" ? parseChartCacheValues(getFirstLocalChild(seriesNode, "bubbleSize"), "numCache", "value") : null;
    const existingShapeProperties = series.shapeProperties && typeof series.shapeProperties === "object" ? series.shapeProperties : null;
    const rawFillColor = typeof existingShapeProperties?.solidFillHex === "string" ? normalizeHexColor(existingShapeProperties.solidFillHex) : null;
    const rawLineColor = typeof existingShapeProperties?.lineColorHex === "string" ? normalizeHexColor(existingShapeProperties.lineColorHex) : null;
    const resolvedLineColor = lineStyle.hidden ? void 0 : rawLineColor ?? lineStyle.color ?? rawFillColor ?? fillColor ?? series.lineColor ?? series.color;
    const hasCategoryReference = typeof series.categoriesRef?.formula === "string" && series.categoriesRef.formula.length > 0;
    const hasValueReference = typeof series.valuesRef?.formula === "string" && series.valuesRef.formula.length > 0;
    const hasBubbleSizeReference = typeof series.bubbleSizeRef?.formula === "string" && series.bubbleSizeRef.formula.length > 0;
    return {
      ...series,
      bubbleSizes: !hasBubbleSizeReference && cachedBubbleSizes ? cachedBubbleSizes.map((value) => typeof value === "number" && Number.isFinite(value) ? value : null) : series.bubbleSizes,
      categories: !hasCategoryReference && cachedCategories ? cachedCategories : series.categories,
      color: rawFillColor ?? rawLineColor ?? fillColor ?? lineStyle.color ?? series.color,
      dataPointStyles: pointStyles.length > 0 ? pointStyles : series.dataPointStyles,
      lineColor: resolvedLineColor,
      lineWidthPx: lineStyle.hidden ? void 0 : lineStyle.widthPx ?? series.lineWidthPx,
      markerColor: rawFillColor ?? rawLineColor ?? resolveChartFillColor(markerShapeProperties, themePalette) ?? fillColor ?? lineStyle.color ?? void 0,
      markerLineColor: rawLineColor ?? rawFillColor ?? markerLineStyle.color ?? lineStyle.color ?? fillColor ?? void 0,
      markerSize: markerSize ?? series.markerSize,
      markerSymbol,
      smooth: readChartBooleanAttribute(seriesNode, "smooth") ?? series.smooth,
      invertIfNegative: invertIfNegative ?? series.invertIfNegative,
      shapeProperties: {
        ...series.shapeProperties,
        xmlExplosion: seriesExplosion ?? void 0,
        xmlFillColor: fillColor ?? void 0,
        xmlLineHidden: lineStyle.hidden ? true : void 0,
        xmlLineColor: lineStyle.color ?? void 0,
        xmlLineWidthPx: lineStyle.widthPx ?? void 0,
        xmlNegativeFillColor: invertNegativeStyle.color ?? void 0,
        xmlNegativeLineColor: invertNegativeStyle.lineColor ?? void 0
      },
      negativeColor: invertNegativeStyle.color ?? series.negativeColor,
      negativeLineColor: invertNegativeStyle.lineColor ?? series.negativeLineColor,
      values: !hasValueReference && cachedValues ? cachedValues.map((value) => typeof value === "number" && Number.isFinite(value) ? value : null) : series.values
    };
  });
}
function applyChartStyleFromXml(chart, chartPath, archive, themePalette) {
  const chartXml = readArchiveText(archive, chartPath);
  if (!chartXml) {
    return;
  }
  const relationships = chartPath ? readChartRelationships(archive, chartPath) : /* @__PURE__ */ new Map();
  const fallbackPointStylesBySeries = parseFallbackPointStylesFromChartXml(chartXml, themePalette);
  const fallbackSeriesStyles = parseFallbackSeriesStylesFromChartXml(chartXml, themePalette);
  const fallbackBubbleSizesBySeries = parseFallbackBubbleSizesFromChartXml(chartXml);
  const applyFallbackSeriesStyles = () => {
    if (fallbackBubbleSizesBySeries.length > 0) {
      chart.series = chart.series.map((series, seriesIndex) => {
        const fallbackBubbleSizes = fallbackBubbleSizesBySeries[seriesIndex] ?? [];
        if (fallbackBubbleSizes.length === 0) {
          return series;
        }
        const currentNumericPointCount = (series.bubbleSizes ?? []).filter(
          (value) => typeof value === "number" && Number.isFinite(value)
        ).length;
        const fallbackNumericPointCount = fallbackBubbleSizes.filter(
          (value) => typeof value === "number" && Number.isFinite(value)
        ).length;
        if (currentNumericPointCount >= fallbackNumericPointCount) {
          return series;
        }
        return {
          ...series,
          bubbleSizes: fallbackBubbleSizes
        };
      });
    }
    if (fallbackPointStylesBySeries.length > 0) {
      chart.series = chart.series.map((series, seriesIndex) => {
        const fallbackPointStyles = fallbackPointStylesBySeries[seriesIndex] ?? [];
        if (fallbackPointStyles.length === 0) {
          return series;
        }
        const existingByIndex = new Map((series.dataPointStyles ?? []).map((entry) => [entry.index, entry]));
        for (const fallbackStyle of fallbackPointStyles) {
          const existing = existingByIndex.get(fallbackStyle.index);
          existingByIndex.set(fallbackStyle.index, {
            color: existing?.color ?? fallbackStyle.color,
            explosion: existing?.explosion ?? fallbackStyle.explosion,
            index: fallbackStyle.index,
            lineColor: existing?.lineColor ?? fallbackStyle.lineColor
          });
        }
        return {
          ...series,
          dataPointStyles: Array.from(existingByIndex.values()).sort((left, right) => left.index - right.index)
        };
      });
    }
    if (fallbackSeriesStyles.length > 0) {
      chart.series = chart.series.map((series, seriesIndex) => {
        const fallbackStyle = fallbackSeriesStyles[seriesIndex];
        if (!fallbackStyle) {
          return series;
        }
        const fallbackColor = fallbackStyle.color ?? fallbackStyle.lineColor;
        return {
          ...series,
          color: series.color ?? fallbackColor,
          lineColor: series.lineColor ?? fallbackStyle.lineColor ?? fallbackColor,
          markerColor: series.markerColor ?? fallbackColor ?? series.color,
          markerLineColor: series.markerLineColor ?? fallbackStyle.lineColor ?? fallbackColor ?? series.lineColor
        };
      });
    }
  };
  const applyRelationshipStyles = () => {
    chart.chartColorPalette = readChartColorPalette(archive, relationships.get(CHART_COLOR_STYLE_REL_TYPE), themePalette);
    const styleAppearance2 = readChartStyleAppearance(
      archive,
      relationships.get(CHART_STYLE_REL_TYPE),
      themePalette
    );
    chart.axisLabelColor = styleAppearance2.axisLabelColor ?? chart.axisLabelColor;
    chart.axisLineColor = styleAppearance2.axisLineColor ?? chart.axisLineColor;
    chart.chartAreaBorderColor = styleAppearance2.chartAreaBorderColor ?? chart.chartAreaBorderColor;
    chart.chartAreaFillColor = styleAppearance2.chartAreaFillColor ?? chart.chartAreaFillColor;
    chart.chartColorPaletteOffset = styleAppearance2.paletteOffset ?? chart.chartColorPaletteOffset;
    chart.textColor = styleAppearance2.textColor ?? chart.textColor;
    chart.titleColor = styleAppearance2.titleColor ?? chart.titleColor;
    return styleAppearance2;
  };
  const applyModernChartExStyles = () => {
    const modernPlotAreaNode = chartDocument?.documentElement ? getFirstLocalDescendant(chartDocument.documentElement, "plotArea") : null;
    if (!modernPlotAreaNode) {
      return;
    }
    const parseModernBinning = (seriesNode) => {
      const layoutPrNode = getFirstLocalChild(seriesNode, "layoutPr");
      const binningNode = layoutPrNode ? getFirstLocalChild(layoutPrNode, "binning") : null;
      if (!binningNode) {
        return null;
      }
      const binning = {};
      for (const attribute of Array.from(binningNode.attributes)) {
        const rawValue = attribute.value;
        const numeric = Number(rawValue);
        binning[attribute.localName || attribute.name] = Number.isFinite(numeric) && rawValue.trim() !== "" ? numeric : rawValue;
      }
      return Object.keys(binning).length > 0 ? binning : {};
    };
    const plotAreaShapeProperties2 = getFirstLocalChild(modernPlotAreaNode, "spPr");
    if (plotAreaShapeProperties2) {
      const plotAreaFillColor = resolveChartFillColor(plotAreaShapeProperties2, themePalette);
      const plotAreaLineStyle = resolveChartLineStyle(plotAreaShapeProperties2, themePalette);
      if (plotAreaFillColor) {
        chart.chartAreaFillColor = chart.chartAreaFillColor ?? plotAreaFillColor;
      }
      if (plotAreaLineStyle.color) {
        chart.chartAreaBorderColor = chart.chartAreaBorderColor ?? plotAreaLineStyle.color;
      }
    }
    const modernSeriesNodes = getLocalDescendants(modernPlotAreaNode, "series");
    if (modernSeriesNodes.length === 0) {
      return;
    }
    chart.series = chart.series.map((series, seriesIndex) => {
      const modernSeriesNode = modernSeriesNodes[seriesIndex] ?? null;
      if (!modernSeriesNode) {
        return series;
      }
      const valueColorsNode = getFirstLocalChild(modernSeriesNode, "valueColors");
      const valueColors = valueColorsNode ? Array.from(valueColorsNode.childNodes).filter((node) => node.nodeType === Node.ELEMENT_NODE).map((node) => resolveChartColorNode(findFirstChartColorElement(node) ?? node, themePalette)).filter((value) => typeof value === "string" && value.length > 0) : [];
      const nextRaw = valueColors.length > 0 ? {
        ...series.raw && typeof series.raw === "object" ? series.raw : {},
        valueColors
      } : series.raw;
      const seriesShapeProperties = getFirstLocalChild(modernSeriesNode, "spPr");
      if (!seriesShapeProperties) {
        return nextRaw === series.raw ? series : {
          ...series,
          raw: nextRaw
        };
      }
      const fillColor = resolveChartFillColor(seriesShapeProperties, themePalette);
      const lineStyle = resolveChartLineStyle(seriesShapeProperties, themePalette);
      const fallbackColor = fillColor ?? lineStyle.color ?? void 0;
      return {
        ...series,
        color: series.color ?? fallbackColor,
        lineColor: series.lineColor ?? lineStyle.color ?? fillColor ?? fallbackColor,
        lineWidthPx: series.lineWidthPx ?? (typeof lineStyle.widthPx === "number" ? lineStyle.widthPx : void 0),
        markerColor: series.markerColor ?? fallbackColor ?? series.color,
        markerLineColor: series.markerLineColor ?? lineStyle.color ?? fallbackColor ?? series.lineColor,
        raw: nextRaw
      };
    });
    const seriesLayouts = modernSeriesNodes.map((node) => node.getAttribute("layoutId") ?? node.getAttribute("layout"));
    const clusteredColumnIndex = seriesLayouts.findIndex((layout) => layout === "clusteredColumn");
    if (clusteredColumnIndex >= 0) {
      const clusteredNode = modernSeriesNodes[clusteredColumnIndex] ?? null;
      const parsedBinning = clusteredNode ? parseModernBinning(clusteredNode) : null;
      if (parsedBinning) {
        const syntheticRawSeries = {
          layoutId: "clusteredColumn",
          layoutPr: {
            binning: parsedBinning
          }
        };
        const hasParetoLine = seriesLayouts.includes("paretoLine");
        const replaceColumnSeries = (series) => series ? buildChartExHistogramSeries(series, syntheticRawSeries, hasParetoLine) : null;
        if (chart.typeGroups && chart.typeGroups.length > 0) {
          const nextTypeGroups = chart.typeGroups.map((group) => ({ ...group, series: [...group.series] }));
          const columnGroupIndex = nextTypeGroups.findIndex((group) => group.chartType === "ColumnClustered");
          if (columnGroupIndex >= 0) {
            const originalColumnSeries = nextTypeGroups[columnGroupIndex]?.series[0] ?? null;
            const binnedColumnSeries = replaceColumnSeries(originalColumnSeries);
            if (binnedColumnSeries) {
              nextTypeGroups[columnGroupIndex].series = [binnedColumnSeries];
              const lineGroupIndex = nextTypeGroups.findIndex((group) => group.chartType === "Line");
              if (lineGroupIndex >= 0 && nextTypeGroups[lineGroupIndex]?.series[0]) {
                const originalLineSeries = nextTypeGroups[lineGroupIndex].series[0];
                const recomputedLine = buildChartExParetoLineSeries(
                  binnedColumnSeries,
                  {
                    text: originalLineSeries.name,
                    ...originalLineSeries.raw && typeof originalLineSeries.raw === "object" ? originalLineSeries.raw : {}
                  },
                  0
                );
                nextTypeGroups[lineGroupIndex].series = [
                  {
                    ...originalLineSeries,
                    categories: recomputedLine.categories,
                    categoriesRef: recomputedLine.categoriesRef,
                    raw: recomputedLine.raw,
                    values: recomputedLine.values
                  }
                ];
                chart.series = [binnedColumnSeries, nextTypeGroups[lineGroupIndex].series[0]];
              } else {
                chart.series = [binnedColumnSeries];
              }
              chart.typeGroups = nextTypeGroups;
            }
          } else if (chart.series[0]) {
            const binnedSeries = replaceColumnSeries(chart.series[0]);
            if (binnedSeries) {
              chart.series = [binnedSeries];
            }
          }
        } else if (chart.series[0]) {
          const binnedSeries = replaceColumnSeries(chart.series[0]);
          if (binnedSeries) {
            chart.series = [binnedSeries];
          }
        }
      }
    }
  };
  const chartDocument = parseXml(chartXml);
  const chartNode = chartDocument ? getFirstLocalDescendant(chartDocument, "chart") : null;
  const plotAreaNode = chartNode ? getFirstLocalChild(chartNode, "plotArea") : null;
  const styleIdNode = chartDocument?.documentElement ? getFirstLocalDescendant(chartDocument.documentElement, "style") : null;
  const chartTypeNode = findPrimaryChartTypeNode(plotAreaNode);
  if (!chartNode || !chartTypeNode) {
    applyRelationshipStyles();
    const fallbackStyleId = readChartNumericAttribute(styleIdNode, "style");
    if (typeof fallbackStyleId === "number" && Number.isFinite(fallbackStyleId)) {
      chart.chartStyleId = fallbackStyleId;
    }
    applyModernChartExStyles();
    applyFallbackSeriesStyles();
    applyBuiltinChartDefaults(chart, themePalette);
    return;
  }
  const plotArea = plotAreaNode;
  if (!plotArea) {
    applyRelationshipStyles();
    applyFallbackSeriesStyles();
    applyBuiltinChartDefaults(chart, themePalette);
    return;
  }
  switch (chartTypeNode.localName) {
    case "barChart":
    case "bar3DChart": {
      const grouping = getFirstLocalChild(chartTypeNode, "grouping")?.getAttribute("val");
      const barDir = getFirstLocalChild(chartTypeNode, "barDir")?.getAttribute("val");
      const isHorizontalBar = barDir === "bar";
      chart.is3d = chartTypeNode.localName === "bar3DChart" ? true : chart.is3d;
      if (grouping === "percentStacked") {
        chart.chartType = isHorizontalBar ? "BarPercentStacked" : "ColumnPercentStacked";
      } else if (grouping === "stacked") {
        chart.chartType = isHorizontalBar ? "BarStacked" : "ColumnStacked";
      } else {
        chart.chartType = isHorizontalBar ? "BarClustered" : "ColumnClustered";
      }
      break;
    }
    case "areaChart":
    case "area3DChart": {
      const grouping = getFirstLocalChild(chartTypeNode, "grouping")?.getAttribute("val");
      chart.is3d = chartTypeNode.localName === "area3DChart" ? true : chart.is3d;
      if (grouping === "stacked") {
        chart.chartType = "AreaStacked";
      } else if (grouping === "percentStacked") {
        chart.chartType = "AreaPercentStacked";
      } else {
        chart.chartType = "Area";
      }
      break;
    }
    case "lineChart":
    case "line3DChart": {
      const grouping = getFirstLocalChild(chartTypeNode, "grouping")?.getAttribute("val");
      chart.is3d = chartTypeNode.localName === "line3DChart" ? true : chart.is3d;
      if (grouping === "stacked") {
        chart.chartType = "LineStacked";
      } else if (grouping === "percentStacked") {
        chart.chartType = "LinePercentStacked";
      } else {
        chart.chartType = "Line";
      }
      break;
    }
    case "pieChart":
      chart.chartType = "Pie";
      break;
    case "pie3DChart":
      chart.chartType = "Pie3D";
      chart.is3d = true;
      break;
    case "doughnutChart":
      chart.chartType = "Doughnut";
      break;
    case "ofPieChart":
      chart.chartType = "BarOfPie";
      break;
    case "scatterChart":
      chart.chartType = resolveScatterChartType(getFirstLocalChild(chartTypeNode, "scatterStyle")?.getAttribute("val"));
      break;
    case "radarChart":
      chart.chartType = "Radar";
      break;
    case "surfaceChart":
      chart.chartType = "Surface";
      chart.is3d = false;
      break;
    case "surface3DChart":
      chart.chartType = "Surface";
      chart.is3d = true;
      break;
    case "stockChart":
      chart.chartType = "Stock";
      break;
    case "bubbleChart":
      chart.chartType = "Bubble";
      break;
    default:
      break;
  }
  const legendNode = getFirstLocalChild(chartNode, "legend");
  const legendPosition = legendNode ? getFirstLocalChild(legendNode, "legendPos")?.getAttribute("val") ?? void 0 : void 0;
  const legendOverlay = legendNode ? getFirstLocalChild(legendNode, "overlay")?.getAttribute("val") : void 0;
  chart.legend = legendNode ? {
    overlay: legendOverlay === "1",
    position: normalizeLegendPosition(legendPosition),
    raw: chart.legend?.raw
  } : chart.legend;
  const plotVisibleOnly = readChartBooleanAttribute(chartNode, "plotVisOnly");
  if (plotVisibleOnly !== void 0) {
    chart.plotVisibleOnly = plotVisibleOnly;
  }
  chart.displayBlanksAs = getFirstLocalChild(chartNode, "dispBlanksAs")?.getAttribute("val") ?? chart.displayBlanksAs;
  const styleId = Number(styleIdNode?.getAttribute("val") ?? Number.NaN);
  chart.chartStyleId = Number.isFinite(styleId) ? styleId : chart.chartStyleId;
  chart.firstSliceAngle = readChartNumericAttribute(chartTypeNode, "firstSliceAng") ?? chart.firstSliceAngle;
  chart.gapWidth = readChartNumericAttribute(chartTypeNode, "gapWidth") ?? chart.gapWidth;
  chart.overlap = readChartNumericAttribute(chartTypeNode, "overlap") ?? chart.overlap;
  chart.bubbleScale = readChartNumericAttribute(chartTypeNode, "bubbleScale") ?? chart.bubbleScale;
  chart.varyColors = readChartBooleanAttribute(chartTypeNode, "varyColors") ?? chart.varyColors;
  const bubble3dNode = getFirstLocalChild(chartTypeNode, "bubble3D");
  chart.bubble3d = bubble3dNode ? bubble3dNode.getAttribute("val") !== "0" : chart.bubble3d;
  chart.holeSize = readChartNumericAttribute(chartTypeNode, "holeSize") ?? chart.holeSize;
  chart.radarStyle = getFirstLocalChild(chartTypeNode, "radarStyle")?.getAttribute("val") ?? chart.radarStyle;
  chart.scatterStyle = getFirstLocalChild(chartTypeNode, "scatterStyle")?.getAttribute("val") ?? chart.scatterStyle;
  chart.shape3d = getFirstLocalChild(chartTypeNode, "shape")?.getAttribute("val") ?? chart.shape3d;
  const wireframeNode = getFirstLocalChild(chartTypeNode, "wireframe");
  chart.wireframe = wireframeNode ? wireframeNode.getAttribute("val") !== "0" : chart.wireframe;
  const chartTypeDataLabels = parseChartDataLabelsFromXml(getFirstLocalChild(chartTypeNode, "dLbls"));
  const firstSeriesNode = getLocalChildren(chartTypeNode, "ser")[0] ?? null;
  const seriesDataLabels = parseChartDataLabelsFromXml(getFirstLocalChild(firstSeriesNode, "dLbls"));
  chart.dataLabels = chartTypeDataLabels ?? seriesDataLabels ?? chart.dataLabels;
  const seriesSp3dNode = firstSeriesNode ? getFirstLocalDescendant(firstSeriesNode, "sp3d") : null;
  chart.surfaceMaterial = seriesSp3dNode?.getAttribute("prstMaterial") ?? chart.surfaceMaterial;
  const bandFormatsNode = getLocalChildren(chartTypeNode, "bandFmts")[0] ?? null;
  const bandFormatNodes = bandFormatsNode ? getLocalChildren(bandFormatsNode, "bandFmt") : [];
  const bandFormatColors = bandFormatNodes.map((bandFormatNode) => {
    const shapeProperties = getFirstLocalChild(bandFormatNode, "spPr");
    return resolveChartFillColor(shapeProperties, themePalette) ?? void 0;
  }).filter((color) => typeof color === "string" && color.length > 0);
  const bandFormatLineColors = bandFormatNodes.map((bandFormatNode) => {
    const shapeProperties = getFirstLocalChild(bandFormatNode, "spPr");
    return resolveChartLineStyle(shapeProperties, themePalette).color ?? void 0;
  }).filter((color) => typeof color === "string" && color.length > 0);
  chart.raw = {
    ...chart.raw ?? {},
    bandFormatCount: bandFormatNodes.length > 0 ? bandFormatNodes.length : void 0,
    bandFormatColors: bandFormatColors.length > 0 ? bandFormatColors : void 0,
    bandFormatLineColors: bandFormatLineColors.length > 0 ? bandFormatLineColors : void 0,
    date1904: readChartBooleanAttribute(chartDocument?.documentElement ?? null, "date1904"),
    bubble3d: chart.bubble3d,
    grouping: getFirstLocalChild(chartTypeNode, "grouping")?.getAttribute("val") ?? void 0,
    ofPieType: getFirstLocalChild(chartTypeNode, "ofPieType")?.getAttribute("val") ?? void 0,
    shape: getFirstLocalChild(chartTypeNode, "shape")?.getAttribute("val") ?? void 0,
    secondPieSize: readChartNumericAttribute(chartTypeNode, "secondPieSize"),
    scatterStyle: chart.scatterStyle,
    splitPos: readChartNumericAttribute(chartTypeNode, "splitPos"),
    splitType: getFirstLocalChild(chartTypeNode, "splitType")?.getAttribute("val") ?? void 0,
    xmlChartType: chartTypeNode.localName
  };
  const view3dNode = getFirstLocalDescendant(chartNode, "view3D");
  if (view3dNode) {
    chart.view3d = {
      depthPercent: readChartNumericAttribute(view3dNode, "depthPercent"),
      perspective: readChartNumericAttribute(view3dNode, "perspective"),
      rAngAx: getFirstLocalChild(view3dNode, "rAngAx")?.getAttribute("val") === "1",
      rotX: readChartNumericAttribute(view3dNode, "rotX"),
      rotY: readChartNumericAttribute(view3dNode, "rotY")
    };
  }
  chart.floor = readChartWallFromXml(getFirstLocalChild(chartNode, "floor"), themePalette) ?? chart.floor;
  chart.sideWall = readChartWallFromXml(getFirstLocalChild(chartNode, "sideWall"), themePalette) ?? chart.sideWall;
  chart.backWall = readChartWallFromXml(getFirstLocalChild(chartNode, "backWall"), themePalette) ?? chart.backWall;
  const styleAppearance = applyRelationshipStyles();
  const chartTextTypeface = readChartTextTypeface(getFirstLocalChild(chartNode, "txPr"), themePalette);
  const titleTypeface = readChartTextTypeface(getFirstLocalDescendant(chartNode, "title"), themePalette);
  chart.fontFamily = chartTextTypeface ?? chart.fontFamily;
  chart.titleFontFamily = titleTypeface ?? chart.titleFontFamily ?? chart.fontFamily;
  const chartAreaShapeProperties = chartDocument?.documentElement ? getFirstLocalChild(chartDocument.documentElement, "spPr") : null;
  const plotAreaShapeProperties = getFirstLocalChild(plotArea, "spPr");
  const chartAreaNoFill = chartAreaShapeProperties ? getFirstLocalChild(chartAreaShapeProperties, "noFill") != null : false;
  const plotAreaNoFill = plotAreaShapeProperties ? getFirstLocalChild(plotAreaShapeProperties, "noFill") != null : false;
  chart.raw = {
    ...chart.raw ?? {},
    chartAreaNoFill: styleAppearance.chartAreaNoFill === true || chartAreaNoFill,
    plotAreaNoFill
  };
  if (chartAreaShapeProperties) {
    const chartAreaFillColor = resolveChartFillColor(chartAreaShapeProperties, themePalette);
    if (chartAreaFillColor) {
      chart.chartAreaFillColor = chartAreaFillColor;
    } else if (getFirstLocalChild(chartAreaShapeProperties, "noFill")) {
      chart.chartAreaFillColor = "transparent";
    }
    const chartAreaLineStyle = resolveChartLineStyle(chartAreaShapeProperties, themePalette);
    if (chartAreaLineStyle.hidden) {
      chart.chartAreaBorderColor = "transparent";
    } else if (chartAreaLineStyle.color) {
      chart.chartAreaBorderColor = chartAreaLineStyle.color;
    }
  }
  if (!chart.chartAreaFillColor && (styleAppearance.chartAreaNoFill === true || plotAreaNoFill)) {
    chart.chartAreaFillColor = "transparent";
  }
  const categoryAxisNodes = [
    ...getLocalChildren(plotArea, "catAx"),
    ...getLocalChildren(plotArea, "dateAx")
  ];
  const valueAxisNodes = getLocalChildren(plotArea, "valAx");
  const seriesAxisNode = getLocalChildren(plotArea, "serAx")[0] ?? null;
  const isScatterLikeChart = chart.chartType === "Scatter" || chart.chartType === "ScatterLines" || chart.chartType === "ScatterSmooth" || chart.chartType === "Bubble";
  let categoryAxisNode = categoryAxisNodes[0] ?? null;
  let valueAxisNode = valueAxisNodes[0] ?? null;
  if (!categoryAxisNode && isScatterLikeChart && valueAxisNodes.length >= 2) {
    categoryAxisNode = valueAxisNodes.find((axisNode) => {
      const position = getFirstLocalChild(axisNode, "axPos")?.getAttribute("val");
      return position === "b" || position === "t";
    }) ?? valueAxisNodes[0];
    valueAxisNode = valueAxisNodes.find((axisNode) => {
      const position = getFirstLocalChild(axisNode, "axPos")?.getAttribute("val");
      return position === "l" || position === "r";
    }) ?? valueAxisNodes[1] ?? valueAxisNodes[0];
  }
  chart.categoryAxis = mergeChartAxis(chart.categoryAxis, readChartAxisFromXml(categoryAxisNode));
  chart.valueAxis = mergeChartAxis(chart.valueAxis, readChartAxisFromXml(valueAxisNode));
  chart.seriesAxis = mergeChartAxis(chart.seriesAxis, readChartAxisFromXml(seriesAxisNode));
  chart.axes = chart.axes.length > 0 ? chart.axes.map((axis, index) => index === 0 && categoryAxisNode ? { ...axis, ...readChartAxisFromXml(categoryAxisNode) } : index === 1 && valueAxisNode ? { ...axis, ...readChartAxisFromXml(valueAxisNode) } : axis) : chart.axes;
  if (seriesAxisNode) {
    const seriesAxis = readChartAxisFromXml(seriesAxisNode);
    if (seriesAxis && !chart.axes.some((axis) => axis.id != null && axis.id === seriesAxis.id)) {
      chart.axes = [...chart.axes, seriesAxis];
    }
  }
  applyChartSeriesStyleFromXml(chart, chartTypeNode, themePalette);
  applyFallbackSeriesStyles();
  if (chart.chartType === "Bubble") {
    const archiveFallbackBubbleSizes = resolveArchiveFallbackBubbleSizes(archive, chart.title);
    if (archiveFallbackBubbleSizes.length > 0) {
      chart.series = chart.series.map((series, seriesIndex) => {
        const pointCount = Math.max(series.values.length, series.categories.length);
        if (pointCount <= 1) {
          return series;
        }
        const numericBubbleCount = (series.bubbleSizes ?? []).filter(
          (value) => typeof value === "number" && Number.isFinite(value)
        ).length;
        if (numericBubbleCount >= pointCount) {
          return series;
        }
        const fallbackCandidate = archiveFallbackBubbleSizes[seriesIndex] ?? archiveFallbackBubbleSizes[0] ?? [];
        const fallbackNumericCount = fallbackCandidate.filter(
          (value) => typeof value === "number" && Number.isFinite(value)
        ).length;
        if (fallbackNumericCount < pointCount) {
          return series;
        }
        return {
          ...series,
          bubbleSizes: fallbackCandidate
        };
      });
    }
  }
  if (chart.chartType === "Pie" || chart.chartType === "Pie3D" || chart.chartType === "PieExploded" || chart.chartType === "Doughnut" || chart.chartType === "BarOfPie") {
    const needsPointColorFallback = chart.series.some((series) => {
      const pointCount = Math.max(series.values.length, series.categories.length);
      if (pointCount <= 0) {
        return false;
      }
      const coloredPointCount = (series.dataPointStyles ?? []).filter(
        (style) => typeof style.color === "string" && style.color.length > 0
      ).length;
      return coloredPointCount === 0;
    });
    if (needsPointColorFallback) {
      const archiveFallbackPointStyles = resolveArchiveFallbackPointStyles(
        archive,
        chart.title,
        chartTypeNode.localName,
        themePalette
      );
      if (archiveFallbackPointStyles.length > 0) {
        chart.series = chart.series.map((series, seriesIndex) => {
          const fallbackStyles = archiveFallbackPointStyles[seriesIndex] ?? archiveFallbackPointStyles[0] ?? [];
          if (fallbackStyles.length === 0) {
            return series;
          }
          const existingByIndex = new Map((series.dataPointStyles ?? []).map((entry) => [entry.index, entry]));
          for (const fallbackStyle of fallbackStyles) {
            const existing = existingByIndex.get(fallbackStyle.index);
            existingByIndex.set(fallbackStyle.index, {
              color: existing?.color ?? fallbackStyle.color,
              explosion: existing?.explosion ?? fallbackStyle.explosion,
              index: fallbackStyle.index,
              lineColor: existing?.lineColor ?? fallbackStyle.lineColor
            });
          }
          return {
            ...series,
            dataPointStyles: Array.from(existingByIndex.values()).sort((left, right) => left.index - right.index)
          };
        });
      }
    }
  }
  applyBuiltinChartDefaults(chart, themePalette);
}
function normalizeArchivePath(path) {
  return path.replace(/^\/+/, "").replace(/\\/g, "/");
}
function dirname(path) {
  const normalized = normalizeArchivePath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}
function resolveRelationshipPath(basePath, target) {
  if (!target) {
    return "";
  }
  const normalizedTarget = target.replace(/\\/g, "/");
  if (normalizedTarget.startsWith("/")) {
    return normalizeArchivePath(normalizedTarget);
  }
  const normalizedBasePath = normalizeArchivePath(basePath);
  let baseDirectory = dirname(normalizedBasePath);
  if (normalizedBasePath.endsWith(".rels")) {
    const relsMarker = "/_rels/";
    const relsMarkerIndex = normalizedBasePath.lastIndexOf(relsMarker);
    if (relsMarkerIndex >= 0) {
      const ownerPrefix = normalizedBasePath.slice(0, relsMarkerIndex);
      const relFileName = normalizedBasePath.slice(relsMarkerIndex + relsMarker.length);
      const ownerFileName = relFileName.endsWith(".rels") ? relFileName.slice(0, -".rels".length) : relFileName;
      baseDirectory = dirname(`${ownerPrefix}/${ownerFileName}`);
    }
  }
  const segments = [...baseDirectory.split("/").filter(Boolean), ...normalizedTarget.split("/").filter(Boolean)];
  const resolved = [];
  for (const segment of segments) {
    if (segment === ".") {
      continue;
    }
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.join("/");
}
function readArchiveText(archive, path) {
  if (!path) {
    return null;
  }
  const entry = archive[normalizeArchivePath(path)];
  return entry ? strFromU8(entry) : null;
}
function parseXml(xml) {
  if (typeof DOMParser === "undefined") {
    return null;
  }
  try {
    return new DOMParser().parseFromString(xml, "application/xml");
  } catch {
    return null;
  }
}
function getLocalChildren(parent, localName) {
  return Array.from(parent.childNodes).filter(
    (node) => node.nodeType === Node.ELEMENT_NODE && node.localName === localName
  );
}
function getLocalDescendants(parent, localName) {
  return Array.from(parent.getElementsByTagName("*")).filter(
    (node) => node.localName === localName
  );
}
function getFirstLocalChild(parent, localName) {
  return getLocalChildren(parent, localName)[0] ?? null;
}
function getFirstLocalDescendant(parent, localName) {
  return getLocalDescendants(parent, localName)[0] ?? null;
}
function unquoteSheetName(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}
function splitSheetReference(reference) {
  let bangIndex = -1;
  let quoted = false;
  for (let index = 0; index < reference.length; index += 1) {
    const char = reference[index];
    if (char === "'") {
      quoted = !quoted;
    } else if (char === "!" && !quoted) {
      bangIndex = index;
      break;
    }
  }
  if (bangIndex < 0) {
    return null;
  }
  return {
    range: reference.slice(bangIndex + 1),
    sheetName: unquoteSheetName(reference.slice(0, bangIndex))
  };
}
function parseA1Cell(reference) {
  const match = /^\$?([A-Z]+)\$?(\d+)$/i.exec(reference.trim());
  if (!match) {
    return null;
  }
  let col = 0;
  for (const char of match[1].toUpperCase()) {
    col = col * 26 + (char.charCodeAt(0) - 64);
  }
  return {
    col: col - 1,
    row: Number(match[2]) - 1
  };
}
function parseA1Range(reference) {
  const [startRef, endRef = startRef] = reference.split(":");
  const start = parseA1Cell(startRef ?? "");
  const end = parseA1Cell(endRef ?? "");
  if (!start || !end) {
    return null;
  }
  return {
    end: {
      col: Math.max(start.col, end.col),
      row: Math.max(start.row, end.row)
    },
    start: {
      col: Math.min(start.col, end.col),
      row: Math.min(start.row, end.row)
    }
  };
}
function formatA1Column(col) {
  let current = col + 1;
  let label = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    current = Math.floor((current - 1) / 26);
  }
  return label;
}
function buildA1RangeFormula(sheetName, start, end) {
  const escapedSheetName = sheetName.replace(/'/g, "''");
  return `'${escapedSheetName}'!$${formatA1Column(start.col)}$${start.row + 1}:$${formatA1Column(end.col)}$${end.row + 1}`;
}
function resolveReferenceSheet(workbook2, fallbackSheetIndex, formula) {
  if (!formula) {
    return {
      range: null,
      sheet: workbook2.getSheet(fallbackSheetIndex),
      sheetName: workbook2.getSheet(fallbackSheetIndex)?.name ?? ""
    };
  }
  const trimmedFormula = formula.trim();
  if (trimmedFormula.length > 0 && !trimmedFormula.includes("!")) {
    try {
      const namedRange = workbook2.getNamedRange(trimmedFormula);
      if (typeof namedRange === "string" && namedRange.length > 0 && namedRange !== trimmedFormula) {
        return resolveReferenceSheet(workbook2, fallbackSheetIndex, namedRange);
      }
    } catch {
    }
  }
  const split = splitSheetReference(trimmedFormula);
  if (!split) {
    return {
      range: parseA1Range(trimmedFormula),
      sheet: workbook2.getSheet(fallbackSheetIndex),
      sheetName: workbook2.getSheet(fallbackSheetIndex)?.name ?? ""
    };
  }
  try {
    return {
      range: parseA1Range(split.range),
      sheet: workbook2.getSheetByName(split.sheetName),
      sheetName: split.sheetName
    };
  } catch {
    return {
      range: parseA1Range(split.range),
      sheet: workbook2.getSheet(fallbackSheetIndex),
      sheetName: workbook2.getSheet(fallbackSheetIndex)?.name ?? ""
    };
  }
}
function resolveChartReferenceLabel(workbook2, fallbackSheetIndex, reference, fallbackLabel) {
  if (!reference?.formula) {
    return fallbackLabel;
  }
  const resolved = resolveReferenceSheet(workbook2, fallbackSheetIndex, reference.formula);
  if (!resolved.sheet || !resolved.range) {
    return fallbackLabel;
  }
  const { start } = resolved.range;
  if (start.row > 0) {
    const headerDisplay = cellValueToDisplay(
      typeof resolved.sheet.getFormattedValueAt === "function" ? resolved.sheet.getFormattedValueAt(start.row - 1, start.col) : null
    );
    if (headerDisplay.length > 0) {
      return headerDisplay;
    }
  }
  const firstDisplay = cellValueToDisplay(
    typeof resolved.sheet.getFormattedValueAt === "function" ? resolved.sheet.getFormattedValueAt(start.row, start.col) : null
  );
  return firstDisplay.length > 0 ? firstDisplay : fallbackLabel;
}
function resolveReferenceRowPaths(workbook2, fallbackSheetIndex, reference) {
  if (!reference?.formula) {
    return [];
  }
  const resolved = resolveReferenceSheet(workbook2, fallbackSheetIndex, reference.formula);
  if (!resolved.sheet || !resolved.range) {
    return [];
  }
  const rows = [];
  for (let row = resolved.range.start.row; row <= resolved.range.end.row; row += 1) {
    const parts = [];
    for (let col = resolved.range.start.col; col <= resolved.range.end.col; col += 1) {
      const calculated = typeof resolved.sheet.getCalculatedValueAt === "function" ? resolved.sheet.getCalculatedValueAt(row, col) : null;
      const formatted = typeof resolved.sheet.getFormattedValueAt === "function" ? resolved.sheet.getFormattedValueAt(row, col) : calculated;
      const display = cellValueToDisplay(formatted ?? calculated);
      const numeric = cellValueToNumber(calculated ?? formatted);
      const label = display.length > 0 ? display : numeric != null ? String(numeric) : "";
      if (label.length > 0) {
        parts.push(label);
      }
    }
    rows.push(parts);
  }
  return rows;
}
function normalizeChartExLegend(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const legend = raw;
  const position = typeof legend.pos === "string" ? normalizeLegendPosition(String(legend.pos)) : void 0;
  return {
    overlay: typeof legend.overlay === "boolean" ? legend.overlay : void 0,
    position,
    raw: legend
  };
}
function humanizeChartExLayoutLabel(layout) {
  if (!layout) {
    return void 0;
  }
  return layout.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").trim().replace(/\b\w/g, (match) => match.toUpperCase());
}
function normalizeChartExAxis(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const axis = raw;
  const scaling = axis.scaling && typeof axis.scaling === "object" ? axis.scaling : null;
  const numberFormat = axis.numberFormat && typeof axis.numberFormat === "object" ? axis.numberFormat : null;
  return {
    delete: typeof axis.hidden === "boolean" ? axis.hidden : void 0,
    id: typeof axis.id === "number" && Number.isFinite(axis.id) ? axis.id : void 0,
    crossId: typeof axis.crossId === "number" && Number.isFinite(axis.crossId) ? axis.crossId : void 0,
    majorGridlines: axis.majorGridlines != null ? true : void 0,
    majorUnit: typeof scaling?.majorUnit === "number" ? scaling.majorUnit : void 0,
    max: typeof scaling?.max === "number" ? scaling.max : void 0,
    min: typeof scaling?.min === "number" ? scaling.min : void 0,
    minorGridlines: axis.minorGridlines != null ? true : void 0,
    minorUnit: typeof scaling?.minorUnit === "number" ? scaling.minorUnit : void 0,
    numberFormat: numberFormat ? {
      formatCode: typeof numberFormat.formatCode === "string" ? numberFormat.formatCode : void 0,
      sourceLinked: typeof numberFormat.sourceLinked === "boolean" ? numberFormat.sourceLinked : void 0
    } : void 0,
    raw: axis,
    position: typeof axis.position === "string" ? axis.position : void 0,
    tickLabelSkip: typeof axis.tickLabelSkip === "number" ? axis.tickLabelSkip : void 0,
    tickMarkSkip: typeof axis.tickMarkSkip === "number" ? axis.tickMarkSkip : void 0
  };
}
function resolveChartExLayoutChartType(layout) {
  switch (layout) {
    case "boxWhisker":
      return "BoxWhisker";
    case "clusteredColumn":
      return "ColumnClustered";
    case "funnel":
      return "Funnel";
    case "paretoLine":
      return "Line";
    case "regionMap":
      return "RegionMap";
    case "sunburst":
      return "Sunburst";
    case "treemap":
      return "Treemap";
    case "waterfall":
      return "Waterfall";
    default:
      return layout ? `Unsupported(cx:${layout})` : "ColumnClustered";
  }
}
function resolveChartExSeriesLayout(raw) {
  if (!raw || typeof raw !== "object") {
    return void 0;
  }
  const record = raw;
  return typeof record.layout === "string" ? record.layout : typeof record.layoutId === "string" ? record.layoutId : void 0;
}
function resolveChartExSeriesAxisIds(raw) {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const record = raw;
  if (Array.isArray(record.axisIds)) {
    return record.axisIds.filter((value) => typeof value === "number" && Number.isFinite(value));
  }
  if (Array.isArray(record.axisId)) {
    return record.axisId.flatMap((value) => {
      if (typeof value === "number" && Number.isFinite(value)) {
        return [value];
      }
      if (value && typeof value === "object" && typeof value.val === "number") {
        return [value.val];
      }
      return [];
    });
  }
  if (typeof record.axisId === "number" && Number.isFinite(record.axisId)) {
    return [record.axisId];
  }
  return [];
}
function niceHistogramStep(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  const exponent = Math.floor(Math.log10(value));
  const scale = 10 ** exponent;
  const normalized = value / scale;
  if (normalized <= 1) {
    return scale;
  }
  if (normalized <= 2) {
    return scale * 2;
  }
  if (normalized <= 5) {
    return scale * 5;
  }
  return scale * 10;
}
function formatHistogramBinLabel(lower, upper, index, closedRight) {
  const leftBracket = closedRight ? index === 0 ? "[" : "(" : "[";
  const rightBracket = closedRight ? "]" : ")";
  return `${leftBracket}${Number(lower.toFixed(6))},${Number(upper.toFixed(6))}${rightBracket}`;
}
function buildChartExHistogramBins(values, rawSeries, sortByFrequency) {
  if (values.length === 0) {
    return [];
  }
  const rawRecord = rawSeries && typeof rawSeries === "object" ? rawSeries : null;
  const layoutProperties = rawRecord?.layoutPr && typeof rawRecord.layoutPr === "object" ? rawRecord.layoutPr : null;
  const rawBinning = layoutProperties?.binning && typeof layoutProperties.binning === "object" ? layoutProperties.binning : null;
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const explicitWidth = typeof rawBinning?.binWidth === "number" && Number.isFinite(rawBinning.binWidth) && rawBinning.binWidth > 0 ? rawBinning.binWidth : typeof rawBinning?.width === "number" && Number.isFinite(rawBinning.width) && rawBinning.width > 0 ? rawBinning.width : void 0;
  const explicitCount = typeof rawBinning?.binCount === "number" && Number.isFinite(rawBinning.binCount) && rawBinning.binCount > 0 ? rawBinning.binCount : typeof rawBinning?.count === "number" && Number.isFinite(rawBinning.count) && rawBinning.count > 0 ? rawBinning.count : void 0;
  const closedRight = rawBinning?.intervalClosed === "r" || rawBinning?.intervalClosed === "right";
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length);
  const standardDeviation = Math.sqrt(Math.max(0, variance));
  const allIntegers = values.every((value) => Math.abs(value - Math.round(value)) < 1e-9);
  const scottWidth = standardDeviation > 0 ? 3.49 * standardDeviation / Math.cbrt(values.length) : void 0;
  const fallbackWidth = explicitCount != null ? (maxValue - minValue) / Math.max(1, explicitCount) : scottWidth ?? (maxValue - minValue) / Math.max(1, Math.ceil(Math.log2(values.length) + 1));
  const roughWidth = explicitWidth ?? (allIntegers ? Math.max(1, Math.ceil(Math.max(fallbackWidth, 1e-6))) : niceHistogramStep(Math.max(fallbackWidth, 1e-6)));
  const binWidth = Math.max(roughWidth, 1e-6);
  const start = explicitWidth != null || explicitCount != null ? Math.floor(minValue / binWidth) * binWidth : minValue;
  const end = Math.max(start + binWidth, start + Math.ceil((maxValue - start) / binWidth) * binWidth);
  const binCount = Math.max(1, Math.ceil((end - start) / binWidth));
  const bins = Array.from({ length: binCount }, (_, index) => {
    const lower = start + binWidth * index;
    const upper = lower + binWidth;
    return {
      count: 0,
      label: formatHistogramBinLabel(lower, upper, index, closedRight),
      lower,
      upper
    };
  });
  values.forEach((value) => {
    if (!Number.isFinite(value)) {
      return;
    }
    const offset = (value - start) / binWidth;
    let binIndex = Math.floor(offset);
    if (closedRight && Math.abs(offset - Math.round(offset)) < 1e-9 && value > start) {
      binIndex -= 1;
    }
    if (value >= end) {
      binIndex = bins.length - 1;
    }
    if (value <= start) {
      binIndex = 0;
    }
    const target = bins[Math.max(0, Math.min(bins.length - 1, binIndex))];
    if (target) {
      target.count += 1;
    }
  });
  if (sortByFrequency) {
    bins.sort((left, right) => right.count - left.count || left.lower - right.lower);
  }
  return bins;
}
function buildChartExHistogramSeries(series, rawSeries, sortByFrequency) {
  const layout = resolveChartExSeriesLayout(rawSeries);
  const rawRecord = rawSeries && typeof rawSeries === "object" ? rawSeries : null;
  const hasBinning = Boolean(
    layout === "clusteredColumn" && rawRecord?.layoutPr && typeof rawRecord.layoutPr === "object" && rawRecord.layoutPr.binning != null
  );
  if (!hasBinning) {
    return series;
  }
  const numericValues = series.values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (numericValues.length === 0) {
    return series;
  }
  const bins = buildChartExHistogramBins(numericValues, rawSeries, sortByFrequency);
  if (bins.length === 0) {
    return series;
  }
  return {
    ...series,
    categories: bins.map((bin) => bin.label),
    categoriesRef: null,
    raw: {
      ...series.raw,
      chartExHistogramBins: bins,
      chartExSourceValues: numericValues
    },
    values: bins.map((bin) => bin.count)
  };
}
function buildChartExParetoLineSeries(series, sourceRaw, index) {
  const counts = series.values.map((value) => typeof value === "number" && Number.isFinite(value) ? value : 0);
  const total = counts.reduce((sum, value) => sum + value, 0);
  let running = 0;
  const cumulative = counts.map((value) => {
    running += value;
    return total > 0 ? running / total * 100 : 0;
  });
  return {
    ...series,
    color: void 0,
    lineColor: void 0,
    markerColor: void 0,
    markerLineColor: void 0,
    markerSize: 7,
    markerSymbol: "circle",
    name: typeof sourceRaw?.text === "string" ? sourceRaw.text : "Pareto",
    raw: {
      ...series.raw ?? {},
      chartExLayout: "paretoLine",
      source: sourceRaw && typeof sourceRaw === "object" ? sourceRaw : void 0
    },
    values: cumulative
  };
}
function resolveChartExTextFormula(raw) {
  if (typeof raw === "string" && raw.length > 0) {
    return raw;
  }
  if (!raw || typeof raw !== "object") {
    return void 0;
  }
  const record = raw;
  if (typeof record.formula === "string" && record.formula.length > 0) {
    return record.formula;
  }
  if (typeof record.text === "string" && record.text.length > 0) {
    return record.text;
  }
  if (typeof record.value === "string" && record.value.length > 0) {
    return record.value;
  }
  return void 0;
}
function resolveChartExTitleText(raw) {
  if (typeof raw === "string" && raw.length > 0) {
    return raw;
  }
  if (!raw || typeof raw !== "object") {
    return void 0;
  }
  const record = raw;
  if (typeof record.text === "string" && record.text.length > 0) {
    return record.text;
  }
  const nestedText = record.text && typeof record.text === "object" ? resolveChartExTextFormula(record.text) : void 0;
  if (nestedText) {
    return nestedText;
  }
  return typeof record.value === "string" && record.value.length > 0 ? record.value : void 0;
}
function resolveChartExFallbackCategoryReference(workbook2, fallbackSheetIndex, valueFormula) {
  if (!valueFormula) {
    return null;
  }
  const resolved = resolveReferenceSheet(workbook2, fallbackSheetIndex, valueFormula);
  if (!resolved.sheet || !resolved.range || resolved.range.start.col <= 0) {
    return null;
  }
  return normalizeChartReference({
    formula: buildA1RangeFormula(
      resolved.sheetName,
      {
        col: resolved.range.start.col - 1,
        row: resolved.range.start.row
      },
      {
        col: resolved.range.start.col - 1,
        row: resolved.range.end.row
      }
    )
  });
}
function normalizeChartExSeries(workbook2, workbookSheetIndex, chartId, raw, dataById, index, chartType) {
  const series = raw && typeof raw === "object" ? raw : {};
  const dataId = typeof series.dataId === "number" ? series.dataId : null;
  const dataEntry = dataId != null ? dataById.get(dataId) ?? null : null;
  const dimensions = Array.isArray(dataEntry?.dimensions) ? dataEntry.dimensions.filter((value) => Boolean(value && typeof value === "object")) : [];
  const categoryDimension = dimensions.find((dimension) => dimension.dimType === "cat") ?? dimensions.find((dimension) => dimension.dimType === "name") ?? null;
  const valueDimension = dimensions.find((dimension) => dimension.dimType === "val" || dimension.dimType === "y" || dimension.dimType === "colorVal" || dimension.dimType === "size") ?? dimensions.find((dimension) => dimension !== categoryDimension) ?? categoryDimension;
  const categoryDimensionFormula = typeof categoryDimension?.formula === "string" ? categoryDimension.formula : void 0;
  const valueDimensionFormula = typeof valueDimension?.formula === "string" ? valueDimension.formula : void 0;
  const fallbackCategoryRef = (chartType === "Sunburst" || chartType === "Treemap") && !categoryDimension && typeof valueDimensionFormula === "string" ? resolveChartExFallbackCategoryReference(workbook2, workbookSheetIndex, valueDimensionFormula) : null;
  const categoriesRef = categoryDimension ? normalizeChartReference({
    formula: categoryDimensionFormula
  }) : fallbackCategoryRef;
  const valuesRef = valueDimension ? normalizeChartReference({
    formula: valueDimensionFormula
  }) : null;
  const resolvedValueCells = resolveReferenceValues(workbook2, workbookSheetIndex, valuesRef, "value");
  const values = resolvedValueCells.map((value) => typeof value === "number" && Number.isFinite(value) ? value : null);
  const colorStrings = chartType === "RegionMap" && valueDimension?.dimType === "colorStr" ? resolvedValueCells.map((value) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    return null;
  }) : [];
  const categories = resolveReferenceValues(workbook2, workbookSheetIndex, categoriesRef, "category");
  const hierarchyCategories = chartType === "Sunburst" || chartType === "Treemap" ? resolveReferenceRowPaths(workbook2, workbookSheetIndex, categoriesRef) : [];
  const seriesTextFormula = resolveChartExTextFormula(series.text);
  const shapeProperties = series.shapeProperties && typeof series.shapeProperties === "object" ? series.shapeProperties : void 0;
  const rawFillColor = typeof shapeProperties?.solidFillHex === "string" ? normalizeHexColor(shapeProperties.solidFillHex) : null;
  const rawLineColor = typeof shapeProperties?.lineColorHex === "string" ? normalizeHexColor(shapeProperties.lineColorHex) : null;
  return {
    bubbleSizeRef: null,
    bubbleSizes: [],
    categories,
    categoriesRef,
    color: rawFillColor ?? void 0,
    dataPoints: Array.isArray(series.dataPoints) ? series.dataPoints : [],
    dataPointStyles: void 0,
    formatIdx: typeof series.formatIdx === "number" ? series.formatIdx : void 0,
    hidden: typeof series.hidden === "boolean" ? series.hidden : void 0,
    id: `${chartId}-series-${index}`,
    invertIfNegative: void 0,
    lineColor: rawLineColor ?? rawFillColor ?? void 0,
    lineWidthPx: typeof shapeProperties?.lineWidth === "number" ? Math.max(1, Number(shapeProperties.lineWidth) / EMU_PER_PIXEL) : void 0,
    marker: void 0,
    markerColor: rawFillColor ?? void 0,
    markerLineColor: rawLineColor ?? rawFillColor ?? void 0,
    markerSize: void 0,
    markerSymbol: void 0,
    name: typeof series.text === "string" ? series.text : seriesTextFormula ? resolveSeriesName(workbook2, workbookSheetIndex, seriesTextFormula) : resolveChartReferenceLabel(workbook2, workbookSheetIndex, valuesRef, `Series ${index + 1}`),
    negativeColor: void 0,
    negativeLineColor: void 0,
    raw: {
      ...series,
      chartExColorStrings: colorStrings,
      chartExHierarchyCategories: hierarchyCategories,
      data: dataEntry,
      dimType: typeof valueDimension?.dimType === "string" ? valueDimension.dimType : void 0
    },
    shapeProperties,
    smooth: void 0,
    values,
    valuesRef
  };
}
function collapseChartExPointSeries(chartType, series) {
  if (chartType !== "Funnel" && chartType !== "Waterfall") {
    if ((chartType === "Sunburst" || chartType === "Treemap") && series.length > 1 && series.every((entry) => {
      const raw = entry.raw && typeof entry.raw === "object" ? entry.raw : null;
      return raw?.dimType === "size";
    })) {
      const primarySeries2 = series.find((entry) => entry.hidden !== true) ?? series[0] ?? null;
      if (!primarySeries2) {
        return series;
      }
      return [
        {
          ...primarySeries2,
          dataPoints: [],
          hidden: false
        }
      ];
    }
    return series;
  }
  const primarySeries = series.find((entry) => entry.hidden !== true) ?? series[0] ?? null;
  if (!primarySeries) {
    return series;
  }
  return [
    {
      ...primarySeries,
      categories: [],
      categoriesRef: null,
      dataPoints: [],
      hidden: false
    }
  ];
}
function normalizeChartExChart(workbook2, workbookSheetIndex, visibleSheetIndex, raw, index, themePalette) {
  const chart = raw && typeof raw === "object" ? raw : {};
  const plotArea = chart.plotArea && typeof chart.plotArea === "object" ? chart.plotArea : {};
  const rawSeries = Array.isArray(plotArea.series) ? plotArea.series : [];
  const seriesLayouts = rawSeries.map(resolveChartExSeriesLayout);
  const dataEntries = Array.isArray(chart.data) ? chart.data : [];
  const dataById = /* @__PURE__ */ new Map();
  dataEntries.forEach((entry) => {
    if (!entry || typeof entry !== "object") {
      return;
    }
    const record = entry;
    if (typeof record.id === "number") {
      dataById.set(record.id, record);
    }
  });
  const axes = Array.isArray(plotArea.axes) ? plotArea.axes.map(normalizeChartExAxis).filter((value) => Boolean(value)) : [];
  const primaryLayout = typeof chart.layout === "string" ? chart.layout : seriesLayouts.find((value) => typeof value === "string" && value.length > 0);
  const fallbackTitle = humanizeChartExLayoutLabel(primaryLayout);
  const chartTitle = resolveChartExTitleText(chart.title) ?? (chart.title != null ? "Chart Title" : fallbackTitle);
  const chartType = resolveChartExLayoutChartType(primaryLayout);
  const normalizedSeries = rawSeries.map((entry, seriesIndex) => normalizeChartExSeries(workbook2, workbookSheetIndex, `chart-ex-${workbookSheetIndex}-${index}`, entry, dataById, seriesIndex, chartType));
  const clusteredColumnSeriesIndex = seriesLayouts.findIndex((layout) => layout === "clusteredColumn");
  const hasParetoLine = seriesLayouts.includes("paretoLine");
  const clusteredColumnAxisIds = clusteredColumnSeriesIndex >= 0 ? resolveChartExSeriesAxisIds(rawSeries[clusteredColumnSeriesIndex]) : [];
  const paretoLineSeriesIndex = seriesLayouts.findIndex((layout) => layout === "paretoLine");
  const paretoLineAxisIds = paretoLineSeriesIndex >= 0 ? resolveChartExSeriesAxisIds(rawSeries[paretoLineSeriesIndex]) : [];
  const primaryHistogramSeries = clusteredColumnSeriesIndex >= 0 ? buildChartExHistogramSeries(normalizedSeries[clusteredColumnSeriesIndex] ?? normalizedSeries[0], rawSeries[clusteredColumnSeriesIndex], hasParetoLine) : null;
  const synthesizedParetoSeries = hasParetoLine && primaryHistogramSeries && primaryHistogramSeries.values.length > 0 ? buildChartExParetoLineSeries(primaryHistogramSeries, rawSeries[paretoLineSeriesIndex], paretoLineSeriesIndex) : null;
  const resolvedSeries = synthesizedParetoSeries ? [primaryHistogramSeries, synthesizedParetoSeries] : primaryHistogramSeries ? [
    primaryHistogramSeries,
    ...normalizedSeries.filter((_, seriesIndex) => seriesIndex !== clusteredColumnSeriesIndex)
  ] : collapseChartExPointSeries(chartType, normalizedSeries);
  const resolvedChartType = primaryHistogramSeries ? "ColumnClustered" : chartType;
  const resolvedGapWidth = primaryHistogramSeries ? 0 : void 0;
  const typeGroups = synthesizedParetoSeries ? [
    {
      axisIds: clusteredColumnAxisIds,
      chartType: "ColumnClustered",
      gapWidth: 0,
      raw: {
        gapWidth: 0,
        layout: "clusteredColumn"
      },
      series: [primaryHistogramSeries]
    },
    {
      axisIds: paretoLineAxisIds,
      chartType: "Line",
      raw: {
        layout: "paretoLine"
      },
      series: [synthesizedParetoSeries]
    }
  ] : [];
  const normalizedChart = {
    anchor: normalizeChartAnchor(chart.anchor),
    autoTitleDeleted: void 0,
    axes,
    axisLabelColor: void 0,
    axisLineColor: void 0,
    categoryAxis: axes[0] ?? null,
    chartAreaBorderColor: void 0,
    chartAreaFillColor: void 0,
    chartColorPalette: void 0,
    chartColorPaletteOffset: void 0,
    chartExLayout: primaryLayout,
    chartPath: void 0,
    chartStyleId: void 0,
    chartType: resolvedChartType,
    dataLabels: rawSeries.length > 0 && rawSeries[0] && typeof rawSeries[0] === "object" ? normalizeChartDataLabels(rawSeries[0].dataLabels) : null,
    displayBlanksAs: void 0,
    editable: true,
    firstSliceAngle: void 0,
    fontFamily: void 0,
    gapWidth: resolvedGapWidth,
    holeSize: void 0,
    id: `chart-ex-${workbookSheetIndex}-${index}`,
    is3d: void 0,
    legend: normalizeChartExLegend(chart.legend),
    name: chartTitle,
    overlap: void 0,
    plotVisibleOnly: void 0,
    raw: chart,
    radarStyle: void 0,
    scatterStyle: void 0,
    roundedCorners: void 0,
    shape3d: void 0,
    seriesAxis: null,
    series: resolvedSeries,
    sheetIndex: visibleSheetIndex,
    showDlblsOverMax: void 0,
    sideWall: null,
    backWall: null,
    bubbleScale: void 0,
    bubble3d: void 0,
    floor: null,
    surfaceMaterial: void 0,
    textColor: void 0,
    title: chartTitle,
    titleColor: void 0,
    titleFontFamily: void 0,
    typeGroups,
    valueAxis: axes.find((axis) => axis.numberFormat || axis.majorGridlines) ?? axes[1] ?? null,
    varyColors: typeof chart.valueColors === "boolean" ? chart.valueColors : void 0,
    view3d: void 0,
    wireframe: void 0,
    workbookSheetIndex,
    zIndex: index
  };
  applyBuiltinChartDefaults(normalizedChart, themePalette);
  return normalizedChart;
}
function cellValueToNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    if (value.is_empty) {
      return null;
    }
    const candidates = [];
    if (typeof value.asNumber === "function") {
      candidates.push(value.asNumber());
    }
    if (typeof value.toJs === "function") {
      candidates.push(value.toJs());
    }
    if (typeof value.asText === "function") {
      candidates.push(value.asText());
    }
    if (typeof value.toString === "function") {
      candidates.push(value.toString());
    }
    for (const candidate of candidates) {
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        return candidate;
      }
      if (typeof candidate === "string") {
        const parsed = Number(candidate.replace(/,/g, ""));
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
function cellValueToDisplay(value) {
  if (value === null || value === void 0) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value && typeof value === "object") {
    if (value.is_empty) {
      return "";
    }
    const candidates = [];
    if (typeof value.asText === "function") {
      candidates.push(value.asText());
    }
    if (typeof value.toJs === "function") {
      candidates.push(value.toJs());
    }
    if (typeof value.toString === "function") {
      candidates.push(value.toString());
    }
    for (const candidate of candidates) {
      if (candidate === null || candidate === void 0) {
        continue;
      }
      if (typeof candidate === "string") {
        return candidate;
      }
      return String(candidate);
    }
  }
  return String(value);
}
function resolveReferenceValues(workbook2, fallbackSheetIndex, reference, mode) {
  if (!reference?.formula) {
    return reference?.values ?? [];
  }
  const resolved = resolveReferenceSheet(workbook2, fallbackSheetIndex, reference.formula);
  if (!resolved.sheet || !resolved.range) {
    return reference.values ?? [];
  }
  const values = [];
  for (let row = resolved.range.start.row; row <= resolved.range.end.row; row += 1) {
    for (let col = resolved.range.start.col; col <= resolved.range.end.col; col += 1) {
      const calculated = typeof resolved.sheet.getCalculatedValueAt === "function" ? resolved.sheet.getCalculatedValueAt(row, col) : null;
      const formatted = typeof resolved.sheet.getFormattedValueAt === "function" ? resolved.sheet.getFormattedValueAt(row, col) : calculated;
      if (mode === "value") {
        values.push(cellValueToNumber(calculated ?? formatted));
      } else {
        const display = cellValueToDisplay(formatted ?? calculated);
        const numeric = cellValueToNumber(calculated ?? formatted);
        values.push(display.length > 0 ? display : numeric !== null ? numeric : null);
      }
    }
  }
  return values;
}
function resolveSeriesName(workbook2, fallbackSheetIndex, rawName) {
  if (typeof rawName !== "string" || !rawName) {
    return void 0;
  }
  const resolved = resolveReferenceSheet(workbook2, fallbackSheetIndex, rawName);
  if (!resolved.sheet || !resolved.range) {
    return rawName;
  }
  const value = typeof resolved.sheet.getFormattedValueAt === "function" ? resolved.sheet.getFormattedValueAt(resolved.range.start.row, resolved.range.start.col) : null;
  const display = cellValueToDisplay(value);
  return display || rawName;
}
function normalizeChartReference(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw;
  return {
    formula: typeof record.formula === "string" ? record.formula : void 0,
    refType: typeof record.refType === "string" ? record.refType : void 0,
    values: Array.isArray(record.values) ? record.values : void 0
  };
}
function normalizeChartAxis(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const rawAxis = raw;
  const axis = rawAxis.axis && typeof rawAxis.axis === "object" ? rawAxis.axis : rawAxis;
  const numberFormat = axis.numberFormat && typeof axis.numberFormat === "object" ? axis.numberFormat : null;
  return {
    crossId: typeof rawAxis.crossId === "number" && Number.isFinite(rawAxis.crossId) ? rawAxis.crossId : void 0,
    crosses: typeof axis.crosses === "string" ? axis.crosses : void 0,
    crossBetween: typeof axis.crossBetween === "string" ? axis.crossBetween : void 0,
    delete: typeof axis.delete === "boolean" ? axis.delete : void 0,
    id: typeof rawAxis.id === "number" && Number.isFinite(rawAxis.id) ? rawAxis.id : void 0,
    labelPosition: typeof axis.labelPosition === "string" ? axis.labelPosition : void 0,
    logBase: typeof axis.logBase === "number" ? axis.logBase : void 0,
    orientation: typeof axis.orientation === "string" ? axis.orientation : void 0,
    majorUnit: typeof axis.majorUnit === "number" ? axis.majorUnit : void 0,
    max: typeof axis.max === "number" ? axis.max : void 0,
    min: typeof axis.min === "number" ? axis.min : void 0,
    majorGridlines: typeof axis.majorGridlines === "boolean" ? axis.majorGridlines : void 0,
    majorTickMark: typeof axis.majorTickMark === "string" ? axis.majorTickMark : void 0,
    minorUnit: typeof axis.minorUnit === "number" ? axis.minorUnit : void 0,
    minorGridlines: typeof axis.minorGridlines === "boolean" ? axis.minorGridlines : void 0,
    minorTickMark: typeof axis.minorTickMark === "string" ? axis.minorTickMark : void 0,
    numberFormat: numberFormat ? {
      formatCode: typeof numberFormat.formatCode === "string" ? numberFormat.formatCode : void 0,
      sourceLinked: typeof numberFormat.sourceLinked === "boolean" ? numberFormat.sourceLinked : void 0
    } : void 0,
    position: typeof axis.position === "string" ? axis.position : void 0,
    raw: axis,
    shapeProperties: axis.shapeProperties && typeof axis.shapeProperties === "object" ? axis.shapeProperties : void 0,
    tickLabelSkip: typeof axis.tickLabelSkip === "number" && Number.isFinite(axis.tickLabelSkip) ? axis.tickLabelSkip : void 0,
    tickMarkSkip: typeof axis.tickMarkSkip === "number" && Number.isFinite(axis.tickMarkSkip) ? axis.tickMarkSkip : void 0
  };
}
function mergeChartAxis(target, patch) {
  if (!patch) {
    return target ?? null;
  }
  return {
    ...target ?? {},
    ...patch
  };
}
function readChartAxisFromXml(axisNode) {
  if (!axisNode) {
    return null;
  }
  const numFmt = getFirstLocalChild(axisNode, "numFmt");
  const scalingNode = getFirstLocalChild(axisNode, "scaling");
  return {
    crossId: readChartNumericAttribute(axisNode, "crossAx"),
    crosses: getFirstLocalChild(axisNode, "crosses")?.getAttribute("val") ?? void 0,
    crossBetween: getFirstLocalChild(axisNode, "crossBetween")?.getAttribute("val") ?? void 0,
    delete: getFirstLocalChild(axisNode, "delete")?.getAttribute("val") === "1" ? true : getFirstLocalChild(axisNode, "delete")?.getAttribute("val") === "0" ? false : void 0,
    id: readChartNumericAttribute(axisNode, "axId"),
    labelPosition: getFirstLocalChild(axisNode, "tickLblPos")?.getAttribute("val") ?? void 0,
    logBase: readChartNumericAttribute(getFirstLocalChild(axisNode, "scaling"), "logBase"),
    orientation: getFirstLocalChild(scalingNode ?? axisNode, "orientation")?.getAttribute("val") ?? void 0,
    majorGridlines: Boolean(getFirstLocalChild(axisNode, "majorGridlines")),
    majorTickMark: getFirstLocalChild(axisNode, "majorTickMark")?.getAttribute("val") ?? void 0,
    majorUnit: readChartNumericAttribute(axisNode, "majorUnit"),
    max: readChartNumericAttribute(scalingNode, "max"),
    min: readChartNumericAttribute(scalingNode, "min"),
    minorGridlines: Boolean(getFirstLocalChild(axisNode, "minorGridlines")),
    minorTickMark: getFirstLocalChild(axisNode, "minorTickMark")?.getAttribute("val") ?? void 0,
    minorUnit: readChartNumericAttribute(axisNode, "minorUnit"),
    numberFormat: numFmt ? {
      formatCode: numFmt.getAttribute("formatCode") ?? void 0,
      sourceLinked: numFmt.getAttribute("sourceLinked") === "1" ? true : numFmt.getAttribute("sourceLinked") === "0" ? false : void 0
    } : void 0,
    position: getFirstLocalChild(axisNode, "axPos")?.getAttribute("val") ?? void 0,
    tickLabelSkip: readChartNumericAttribute(axisNode, "tickLblSkip"),
    tickMarkSkip: readChartNumericAttribute(axisNode, "tickMarkSkip")
  };
}
function readChartWallFromXml(wallNode, themePalette) {
  if (!wallNode) {
    return null;
  }
  const shapeProperties = getFirstLocalChild(wallNode, "spPr");
  const lineStyle = resolveChartLineStyle(shapeProperties, themePalette);
  return {
    fillColor: resolveChartFillColor(shapeProperties, themePalette) ?? void 0,
    hidden: shapeProperties ? getFirstLocalChild(shapeProperties, "noFill") != null : void 0,
    lineColor: lineStyle.color ?? void 0,
    thickness: readChartNumericAttribute(wallNode, "thickness")
  };
}
function normalizeChartDataLabels(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const labels = raw;
  const pointLabels = Array.isArray(labels.pointLabels) ? (() => {
    const normalized = [];
    for (const entry of labels.pointLabels) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const point = entry;
      const index = typeof point.index === "number" && Number.isFinite(point.index) ? point.index : null;
      if (index == null) {
        continue;
      }
      const nextPoint = { index };
      if (typeof point.deleted === "boolean") {
        nextPoint.deleted = point.deleted;
      }
      if (typeof point.fontSizePt === "number" && Number.isFinite(point.fontSizePt)) {
        nextPoint.fontSizePt = point.fontSizePt;
      }
      if (typeof point.showBubbleSize === "boolean") {
        nextPoint.showBubbleSize = point.showBubbleSize;
      }
      if (typeof point.showCategoryName === "boolean") {
        nextPoint.showCategoryName = point.showCategoryName;
      }
      if (typeof point.showPercent === "boolean") {
        nextPoint.showPercent = point.showPercent;
      }
      if (typeof point.showSeriesName === "boolean") {
        nextPoint.showSeriesName = point.showSeriesName;
      }
      if (typeof point.showValue === "boolean") {
        nextPoint.showValue = point.showValue;
      }
      if (typeof point.x === "number" && Number.isFinite(point.x)) {
        nextPoint.x = point.x;
      }
      if (typeof point.y === "number" && Number.isFinite(point.y)) {
        nextPoint.y = point.y;
      }
      normalized.push(nextPoint);
    }
    return normalized;
  })() : void 0;
  return {
    pointLabels: pointLabels && pointLabels.length > 0 ? pointLabels : void 0,
    raw: labels,
    showBubbleSize: typeof labels.showBubbleSize === "boolean" ? labels.showBubbleSize : void 0,
    showCategoryName: typeof labels.showCategoryName === "boolean" ? labels.showCategoryName : void 0,
    showLegendKey: typeof labels.showLegendKey === "boolean" ? labels.showLegendKey : void 0,
    showPercent: typeof labels.showPercent === "boolean" ? labels.showPercent : void 0,
    showSeriesName: typeof labels.showSeriesName === "boolean" ? labels.showSeriesName : void 0,
    showValue: typeof labels.showValue === "boolean" ? labels.showValue : void 0
  };
}
function normalizeChartAnchor(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      kind: "two-cell",
      from: { col: 0, colOffsetEmu: 0, row: 0, rowOffsetEmu: 0 },
      to: { col: 8, colOffsetEmu: 0, row: 15, rowOffsetEmu: 0 }
    };
  }
  const anchor = raw;
  const fromCol = typeof anchor.fromCol === "number" ? anchor.fromCol : 0;
  const fromColOffsetEmu = typeof anchor.fromColOffset === "number" ? anchor.fromColOffset : 0;
  const fromRow = typeof anchor.fromRow === "number" ? anchor.fromRow : 0;
  const fromRowOffsetEmu = typeof anchor.fromRowOffset === "number" ? anchor.fromRowOffset : 0;
  const rawToCol = typeof anchor.toCol === "number" ? anchor.toCol : null;
  const rawToColOffsetEmu = typeof anchor.toColOffset === "number" ? anchor.toColOffset : 0;
  const rawToRow = typeof anchor.toRow === "number" ? anchor.toRow : null;
  const rawToRowOffsetEmu = typeof anchor.toRowOffset === "number" ? anchor.toRowOffset : 0;
  const hasExplicitTo = rawToCol !== null && rawToRow !== null;
  const collapsedWidth = hasExplicitTo && (rawToCol < fromCol || rawToCol === fromCol && rawToColOffsetEmu <= fromColOffsetEmu);
  const collapsedHeight = hasExplicitTo && (rawToRow < fromRow || rawToRow === fromRow && rawToRowOffsetEmu <= fromRowOffsetEmu);
  const fallbackToCol = Math.max(fromCol + 8, 8);
  const fallbackToRow = Math.max(fromRow + 15, 15);
  return {
    kind: "two-cell",
    from: {
      col: fromCol,
      colOffsetEmu: fromColOffsetEmu,
      row: fromRow,
      rowOffsetEmu: fromRowOffsetEmu
    },
    to: {
      col: !hasExplicitTo || collapsedWidth ? fallbackToCol : rawToCol,
      colOffsetEmu: !hasExplicitTo || collapsedWidth ? 0 : rawToColOffsetEmu,
      row: !hasExplicitTo || collapsedHeight ? fallbackToRow : rawToRow,
      rowOffsetEmu: !hasExplicitTo || collapsedHeight ? 0 : rawToRowOffsetEmu
    }
  };
}
function parseMarkerNode(node) {
  if (!node) {
    return null;
  }
  const col = Number(getFirstLocalChild(node, "col")?.textContent ?? Number.NaN);
  const row = Number(getFirstLocalChild(node, "row")?.textContent ?? Number.NaN);
  const colOffsetEmu = Number(getFirstLocalChild(node, "colOff")?.textContent ?? 0);
  const rowOffsetEmu = Number(getFirstLocalChild(node, "rowOff")?.textContent ?? 0);
  if (!Number.isFinite(col) || !Number.isFinite(row)) {
    return null;
  }
  return {
    col: Math.max(0, Math.round(col)),
    colOffsetEmu: Number.isFinite(colOffsetEmu) ? Math.max(0, Math.round(colOffsetEmu)) : 0,
    row: Math.max(0, Math.round(row)),
    rowOffsetEmu: Number.isFinite(rowOffsetEmu) ? Math.max(0, Math.round(rowOffsetEmu)) : 0
  };
}
function parseChartAnchorNode(anchorNode) {
  if (anchorNode.localName === "twoCellAnchor") {
    const from = parseMarkerNode(getFirstLocalChild(anchorNode, "from"));
    const to = parseMarkerNode(getFirstLocalChild(anchorNode, "to"));
    return from && to ? { from, kind: "two-cell", to } : null;
  }
  if (anchorNode.localName === "oneCellAnchor") {
    const from = parseMarkerNode(getFirstLocalChild(anchorNode, "from"));
    const ext2 = getFirstLocalChild(anchorNode, "ext");
    const cx2 = Number(ext2?.getAttribute("cx") ?? Number.NaN);
    const cy2 = Number(ext2?.getAttribute("cy") ?? Number.NaN);
    return from && Number.isFinite(cx2) && Number.isFinite(cy2) ? {
      from,
      kind: "one-cell",
      sizeEmu: {
        cx: Math.max(0, Math.round(cx2)),
        cy: Math.max(0, Math.round(cy2))
      }
    } : null;
  }
  const pos = getFirstLocalChild(anchorNode, "pos");
  const ext = getFirstLocalChild(anchorNode, "ext");
  const x = Number(pos?.getAttribute("x") ?? Number.NaN);
  const y = Number(pos?.getAttribute("y") ?? Number.NaN);
  const cx = Number(ext?.getAttribute("cx") ?? Number.NaN);
  const cy = Number(ext?.getAttribute("cy") ?? Number.NaN);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(cx) && Number.isFinite(cy) ? {
    kind: "absolute",
    positionEmu: {
      x: Math.round(x),
      y: Math.round(y)
    },
    sizeEmu: {
      cx: Math.max(0, Math.round(cx)),
      cy: Math.max(0, Math.round(cy))
    }
  } : null;
}
function isCollapsedChartAnchor(anchor) {
  if (anchor.kind !== "two-cell") {
    return false;
  }
  const collapsedWidth = anchor.to.col < anchor.from.col || anchor.to.col === anchor.from.col && anchor.to.colOffsetEmu <= anchor.from.colOffsetEmu;
  const collapsedHeight = anchor.to.row < anchor.from.row || anchor.to.row === anchor.from.row && anchor.to.rowOffsetEmu <= anchor.from.rowOffsetEmu;
  return collapsedWidth || collapsedHeight;
}
function normalizeChartSeries(workbook2, workbookSheetIndex, chartId, raw, index) {
  const series = raw && typeof raw === "object" ? raw : {};
  const categoriesRef = normalizeChartReference(series.categories);
  const valuesRef = normalizeChartReference(series.values);
  const shapeProperties = series.shapeProperties && typeof series.shapeProperties === "object" ? series.shapeProperties : void 0;
  const rawFillColor = typeof shapeProperties?.solidFillHex === "string" ? normalizeHexColor(shapeProperties.solidFillHex) : null;
  const rawLineColor = typeof shapeProperties?.lineColorHex === "string" ? normalizeHexColor(shapeProperties.lineColorHex) : null;
  const bubbleSizeRef = normalizeChartReference(series.bubbleSize ?? series.bubbleSizes ?? series.bubbles);
  return {
    bubbleSizeRef,
    bubbleSizes: resolveReferenceValues(workbook2, workbookSheetIndex, bubbleSizeRef, "value").map((value) => typeof value === "number" && Number.isFinite(value) ? value : null),
    categories: resolveReferenceValues(workbook2, workbookSheetIndex, categoriesRef, "category"),
    categoriesRef,
    color: rawFillColor ?? void 0,
    dataPoints: Array.isArray(series.dataPoints) ? series.dataPoints : [],
    dataPointStyles: void 0,
    id: `${chartId}-series-${index}`,
    invertIfNegative: typeof series.invertIfNegative === "boolean" ? series.invertIfNegative : void 0,
    lineColor: rawLineColor ?? rawFillColor ?? void 0,
    lineWidthPx: typeof shapeProperties?.lineWidth === "number" ? Math.max(1, Number(shapeProperties.lineWidth) / EMU_PER_PIXEL) : void 0,
    marker: series.marker && typeof series.marker === "object" ? series.marker : void 0,
    markerColor: void 0,
    markerLineColor: void 0,
    markerSize: series.marker && typeof series.marker === "object" && typeof series.marker.size === "number" ? Number(series.marker.size) : void 0,
    markerSymbol: series.marker && typeof series.marker === "object" && typeof series.marker.symbol === "string" ? String(series.marker.symbol) : void 0,
    name: resolveSeriesName(workbook2, workbookSheetIndex, series.name),
    negativeColor: void 0,
    negativeLineColor: void 0,
    raw: series,
    shapeProperties,
    smooth: typeof series.smooth === "boolean" ? series.smooth : void 0,
    values: resolveReferenceValues(workbook2, workbookSheetIndex, valuesRef, "value").map((value) => typeof value === "number" && Number.isFinite(value) ? value : null),
    valuesRef
  };
}
function normalizeChartTypeGroup(workbook2, workbookSheetIndex, chartId, raw, index) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const group = raw;
  const rawSeries = Array.isArray(group.series) ? group.series : [];
  return {
    axisIds: Array.isArray(group.axisIds) ? group.axisIds.filter((value) => typeof value === "number" && Number.isFinite(value)) : void 0,
    chartType: typeof group.chartType === "string" ? group.chartType : "ColumnClustered",
    dataLabels: normalizeChartDataLabels(group.dataLabels),
    gapWidth: typeof group.gapWidth === "number" && Number.isFinite(group.gapWidth) ? group.gapWidth : void 0,
    is3d: typeof group.is3d === "boolean" ? group.is3d : void 0,
    overlap: typeof group.overlap === "number" && Number.isFinite(group.overlap) ? group.overlap : void 0,
    raw: group,
    series: rawSeries.map((entry, seriesIndex) => normalizeChartSeries(workbook2, workbookSheetIndex, `${chartId}-group-${index}`, entry, seriesIndex)),
    varyColors: typeof group.varyColors === "boolean" ? group.varyColors : void 0
  };
}
function normalizeChartsheet(raw, index) {
  const chartsheet = raw && typeof raw === "object" ? raw : {};
  return {
    chartIds: Array.isArray(chartsheet.chartIds) ? chartsheet.chartIds.filter((value) => typeof value === "string") : [],
    chartPath: typeof chartsheet.chartPath === "string" ? chartsheet.chartPath : void 0,
    id: `chartsheet-${index}`,
    index,
    name: typeof chartsheet.name === "string" ? chartsheet.name : `Chart ${index + 1}`,
    raw: chartsheet,
    workbookSheetIndex: typeof chartsheet.workbookSheetIndex === "number" ? chartsheet.workbookSheetIndex : void 0
  };
}
function buildTabs(workbook2, chartsheets2, visibleSheetIndexByWorkbookSheetIndex, showHiddenSheets = false) {
  const rawOrder = Array.isArray(workbook2.sheetOrder) ? workbook2.sheetOrder : [];
  if (rawOrder.length === 0) {
    return workbook2.sheetNames.flatMap((name, index) => {
      const worksheet = workbook2.getSheet(index);
      const visibility = normalizeWorksheetVisibility(worksheet.visibility);
      if (!showHiddenSheets && visibility !== "visible") {
        return [];
      }
      return [{
        id: `sheet-${index}`,
        index,
        kind: "sheet",
        name,
        sheetIndex: visibleSheetIndexByWorkbookSheetIndex.get(index) ?? index,
        visibility,
        workbookSheetIndex: index
      }];
    });
  }
  return rawOrder.flatMap((entry, index) => {
    const slotType = typeof entry.slotType === "string" ? entry.slotType : "worksheet";
    const slotIndex = typeof entry.index === "number" ? entry.index : index;
    if (slotType === "chartsheet") {
      const chartsheet = chartsheets2[slotIndex];
      return chartsheet ? [{
        chartsheetIndex: slotIndex,
        id: `chartsheet-${slotIndex}`,
        index,
        kind: "chartsheet",
        name: chartsheet.name
      }] : [];
    }
    const worksheet = workbook2.getSheet(slotIndex);
    const visibility = normalizeWorksheetVisibility(worksheet.visibility);
    if (!showHiddenSheets && visibility !== "visible") {
      return [];
    }
    return [{
      id: `sheet-${slotIndex}`,
      index,
      kind: "sheet",
      name: worksheet.name,
      sheetIndex: visibleSheetIndexByWorkbookSheetIndex.get(slotIndex) ?? slotIndex,
      visibility,
      workbookSheetIndex: slotIndex
    }];
  });
}
function collectChartOriginsForSheet(archive, origin) {
  if (!origin) {
    return [];
  }
  const chartOrigins = [];
  for (const attachment of origin.attachments) {
    const drawingXml = readArchiveText(archive, attachment.drawingPath);
    const relsXml = readArchiveText(archive, attachment.drawingRelsPath);
    if (!drawingXml || !relsXml) {
      continue;
    }
    const drawingDocument = parseXml(drawingXml);
    const relsDocument = parseXml(relsXml);
    if (!drawingDocument || !relsDocument) {
      continue;
    }
    const relationships = /* @__PURE__ */ new Map();
    for (const node of getLocalDescendants(relsDocument, "Relationship")) {
      const id = node.getAttribute("Id");
      const target = node.getAttribute("Target");
      const type = node.getAttribute("Type");
      if (id && target) {
        relationships.set(id, {
          target: resolveRelationshipPath(attachment.drawingRelsPath ?? attachment.drawingPath, target),
          type
        });
      }
    }
    const anchorNodes = Array.from(drawingDocument.documentElement.childNodes).filter(
      (node) => node.nodeType === Node.ELEMENT_NODE && (node.localName === "twoCellAnchor" || node.localName === "oneCellAnchor" || node.localName === "absoluteAnchor")
    );
    let chartAnchorIndex = 0;
    for (const anchorNode of anchorNodes) {
      const graphicFrame = getFirstLocalDescendant(anchorNode, "graphicFrame");
      const chartNode = graphicFrame ? getFirstLocalDescendant(graphicFrame, "chart") : null;
      const relationshipId = chartNode?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? chartNode?.getAttribute("r:id") ?? chartNode?.getAttribute("id");
      if (!relationshipId) {
        continue;
      }
      const relationship = relationships.get(relationshipId);
      if (!relationship || relationship.type !== CHART_REL_TYPE && relationship.type !== CHART_EX_REL_TYPE) {
        continue;
      }
      chartOrigins.push({
        anchorIndex: chartAnchorIndex,
        anchor: parseChartAnchorNode(anchorNode),
        chartKind: relationship.type === CHART_EX_REL_TYPE ? "modern" : "classic",
        chartPath: relationship.target,
        drawingPath: attachment.drawingPath,
        workbookSheetIndex: origin.workbookSheetIndex
      });
      chartAnchorIndex += 1;
    }
  }
  return chartOrigins;
}
function applyChartOrigins(chartsByWorkbookSheetIndex2, chartOriginsById, archive, sheetOrigins) {
  for (let workbookSheetIndex = 0; workbookSheetIndex < chartsByWorkbookSheetIndex2.length; workbookSheetIndex += 1) {
    const charts = chartsByWorkbookSheetIndex2[workbookSheetIndex] ?? [];
    const origins = collectChartOriginsForSheet(archive, sheetOrigins[workbookSheetIndex] ?? null);
    const originsByKind = {
      classic: origins.filter((origin) => origin.chartKind === "classic"),
      modern: origins.filter((origin) => origin.chartKind === "modern")
    };
    const chartIndexByKind = {
      classic: 0,
      modern: 0
    };
    charts.forEach((chart) => {
      const chartKind = chart.id.startsWith("chart-ex-") ? "modern" : "classic";
      const origin = originsByKind[chartKind][chartIndexByKind[chartKind]];
      chartIndexByKind[chartKind] += 1;
      if (!origin) {
        return;
      }
      if (origin.anchor && isCollapsedChartAnchor(chart.anchor)) {
        chart.anchor = origin.anchor;
      } else if (origin.anchor && chart.anchor.kind === "two-cell" && chart.anchor.from.col === 0 && chart.anchor.from.row === 0) {
        chart.anchor = origin.anchor;
      }
      chart.chartPath = origin.chartPath ?? void 0;
      chartOriginsById.set(chart.id, origin);
    });
  }
}
function loadWorkbookChartAssets(workbook2, imageAssets, visibleSheetIndexByWorkbookSheetIndex, showHiddenSheets = false) {
  const chartsByWorkbookSheetIndex2 = Array.from({ length: workbook2.sheetCount }, (_, workbookSheetIndex) => {
    const worksheet = workbook2.getSheet(workbookSheetIndex);
    const rawCharts = Array.isArray(worksheet.charts) ? worksheet.charts : [];
    const rawChartsEx = Array.isArray(worksheet.chartsEx) ? worksheet.chartsEx : [];
    const visibleSheetIndex = visibleSheetIndexByWorkbookSheetIndex.get(workbookSheetIndex) ?? workbookSheetIndex;
    const classicCharts = rawCharts.map((rawChart, chartIndex) => {
      const chartId = `chart-${workbookSheetIndex}-${chartIndex}`;
      const chart = rawChart && typeof rawChart === "object" ? rawChart : {};
      const rawView3d = chart.view3d && typeof chart.view3d === "object" ? chart.view3d : null;
      const rawSeries = Array.isArray(chart.series) ? chart.series : [];
      const chartLevelDataLabels = normalizeChartDataLabels(chart.dataLabels);
      const firstSeriesDataLabels = rawSeries.length > 0 && rawSeries[0] && typeof rawSeries[0] === "object" ? normalizeChartDataLabels(rawSeries[0].dataLabels) : null;
      return {
        anchor: normalizeChartAnchor(chart.anchor),
        autoTitleDeleted: typeof chart.autoTitleDeleted === "boolean" ? chart.autoTitleDeleted : void 0,
        axes: Array.isArray(chart.axes) ? chart.axes.map(normalizeChartAxis).filter((value) => Boolean(value)) : [],
        axisLabelColor: void 0,
        axisLineColor: void 0,
        categoryAxis: normalizeChartAxis(chart.categoryAxis),
        chartAreaBorderColor: void 0,
        chartAreaFillColor: void 0,
        chartColorPalette: void 0,
        chartColorPaletteOffset: void 0,
        chartPath: void 0,
        chartStyleId: void 0,
        chartType: typeof chart.chartType === "string" ? chart.chartType : "ColumnClustered",
        dataLabels: chartLevelDataLabels ?? firstSeriesDataLabels,
        displayBlanksAs: typeof chart.displayBlanksAs === "string" ? chart.displayBlanksAs : void 0,
        editable: true,
        firstSliceAngle: typeof chart.firstSliceAngle === "number" ? chart.firstSliceAngle : void 0,
        fontFamily: void 0,
        gapWidth: typeof chart.gapWidth === "number" ? chart.gapWidth : void 0,
        holeSize: typeof chart.holeSize === "number" ? chart.holeSize : void 0,
        id: chartId,
        is3d: typeof chart.is3d === "boolean" ? chart.is3d : void 0,
        legend: normalizeLegend(chart.legend) ? {
          ...normalizeLegend(chart.legend),
          position: normalizeLegendPosition(normalizeLegend(chart.legend)?.position)
        } : null,
        name: typeof chart.name === "string" ? chart.name : void 0,
        overlap: typeof chart.overlap === "number" ? chart.overlap : void 0,
        plotVisibleOnly: typeof chart.plotVisibleOnly === "boolean" ? chart.plotVisibleOnly : void 0,
        raw: chart,
        radarStyle: typeof chart.radarStyle === "string" ? chart.radarStyle : void 0,
        scatterStyle: typeof chart.scatterStyle === "string" ? chart.scatterStyle : void 0,
        roundedCorners: typeof chart.roundedCorners === "boolean" ? chart.roundedCorners : void 0,
        shape3d: typeof chart.shape === "string" ? chart.shape : typeof chart.shape3d === "string" ? chart.shape3d : void 0,
        seriesAxis: null,
        series: rawSeries.map((entry, seriesIndex) => normalizeChartSeries(workbook2, workbookSheetIndex, chartId, entry, seriesIndex)),
        sheetIndex: visibleSheetIndex,
        showDlblsOverMax: typeof chart.showDlblsOverMax === "boolean" ? chart.showDlblsOverMax : void 0,
        sideWall: null,
        backWall: null,
        bubbleScale: typeof chart.bubbleScale === "number" ? chart.bubbleScale : void 0,
        bubble3d: typeof chart.bubble3d === "boolean" ? chart.bubble3d : void 0,
        floor: null,
        surfaceMaterial: void 0,
        textColor: void 0,
        title: typeof chart.title === "string" ? chart.title : void 0,
        titleColor: void 0,
        titleFontFamily: void 0,
        typeGroups: Array.isArray(chart.typeGroups) ? chart.typeGroups.map((entry, groupIndex) => normalizeChartTypeGroup(workbook2, workbookSheetIndex, chartId, entry, groupIndex)).filter((value) => value != null) : [],
        valueAxis: normalizeChartAxis(chart.valueAxis),
        varyColors: typeof chart.varyColors === "boolean" ? chart.varyColors : void 0,
        view3d: rawView3d ? {
          depthPercent: typeof rawView3d.depthPercent === "number" ? rawView3d.depthPercent : void 0,
          perspective: typeof rawView3d.perspective === "number" ? rawView3d.perspective : void 0,
          rAngAx: typeof rawView3d.rAngAx === "boolean" ? rawView3d.rAngAx : typeof rawView3d.rightAngleAxes === "boolean" ? rawView3d.rightAngleAxes : void 0,
          rotX: typeof rawView3d.rotX === "number" ? rawView3d.rotX : typeof rawView3d.rotateX === "number" ? rawView3d.rotateX : void 0,
          rotY: typeof rawView3d.rotY === "number" ? rawView3d.rotY : typeof rawView3d.rotateY === "number" ? rawView3d.rotateY : void 0
        } : void 0,
        wireframe: typeof chart.wireframe === "boolean" ? chart.wireframe : void 0,
        workbookSheetIndex,
        zIndex: 200 + chartIndex
      };
    });
    const modernCharts = rawChartsEx.map((rawChartEx, chartExIndex) => normalizeChartExChart(
      workbook2,
      workbookSheetIndex,
      visibleSheetIndex,
      rawChartEx,
      chartExIndex,
      imageAssets?.themePalette ?? null
    ));
    return [...classicCharts, ...modernCharts];
  });
  const chartsheets2 = Array.isArray(workbook2.chartsheets) ? workbook2.chartsheets.map((entry, index) => normalizeChartsheet(entry, index)) : [];
  const tabs2 = buildTabs(workbook2, chartsheets2, visibleSheetIndexByWorkbookSheetIndex, showHiddenSheets);
  const chartOriginsById = /* @__PURE__ */ new Map();
  if (imageAssets) {
    applyChartOrigins(chartsByWorkbookSheetIndex2, chartOriginsById, imageAssets.archive, imageAssets.sheetOrigins);
    for (const charts of chartsByWorkbookSheetIndex2) {
      for (const chart of charts) {
        applyChartStyleFromXml(chart, chart.chartPath, imageAssets.archive, imageAssets.themePalette);
        applyBuiltinChartDefaults(chart, imageAssets.themePalette);
      }
    }
  } else {
    for (const charts of chartsByWorkbookSheetIndex2) {
      for (const chart of charts) {
        applyBuiltinChartDefaults(chart, null);
      }
    }
  }
  return {
    chartOriginsById,
    chartsByWorkbookSheetIndex: chartsByWorkbookSheetIndex2,
    chartsheets: chartsheets2,
    tabs: tabs2
  };
}

// src/images.ts
import { strFromU8 as strFromU82, strToU8 as strToU82, unzipSync, zipSync } from "fflate";

// src/colors.ts
function normalizeHexColor2(value) {
  const hex = value.replace(/^#/, "");
  if (hex.length === 8) {
    return `#${hex.slice(2).toLowerCase()}`;
  }
  if (hex.length === 6) {
    return `#${hex.toLowerCase()}`;
  }
  return null;
}
function parseHexColor2(color) {
  const normalized = normalizeHexColor2(color);
  const match = normalized ? /^#([0-9a-f]{6})$/.exec(normalized) : null;
  if (!match) {
    return null;
  }
  const hex = match[1];
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16)
  ];
}
function rgbToHsl2(red, green, blue) {
  const normalizedRed = red / 255;
  const normalizedGreen = green / 255;
  const normalizedBlue = blue / 255;
  const max = Math.max(normalizedRed, normalizedGreen, normalizedBlue);
  const min = Math.min(normalizedRed, normalizedGreen, normalizedBlue);
  const lightness = (max + min) / 2;
  if (max === min) {
    return [0, 0, lightness];
  }
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;
  switch (max) {
    case normalizedRed:
      hue = (normalizedGreen - normalizedBlue) / delta + (normalizedGreen < normalizedBlue ? 6 : 0);
      break;
    case normalizedGreen:
      hue = (normalizedBlue - normalizedRed) / delta + 2;
      break;
    default:
      hue = (normalizedRed - normalizedGreen) / delta + 4;
      break;
  }
  return [hue / 6, saturation, lightness];
}
function hueToRgb2(p, q, t) {
  let nextT = t;
  if (nextT < 0) {
    nextT += 1;
  }
  if (nextT > 1) {
    nextT -= 1;
  }
  if (nextT < 1 / 6) {
    return p + (q - p) * 6 * nextT;
  }
  if (nextT < 1 / 2) {
    return q;
  }
  if (nextT < 2 / 3) {
    return p + (q - p) * (2 / 3 - nextT) * 6;
  }
  return p;
}
function hslToRgb2(hue, saturation, lightness) {
  if (saturation === 0) {
    const gray = Math.round(lightness * 255);
    return [gray, gray, gray];
  }
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return [
    Math.round(hueToRgb2(p, q, hue + 1 / 3) * 255),
    Math.round(hueToRgb2(p, q, hue) * 255),
    Math.round(hueToRgb2(p, q, hue - 1 / 3) * 255)
  ];
}
function rgbToHex2(red, green, blue) {
  return `#${[red, green, blue].map((channel) => Math.max(0, Math.min(255, channel)).toString(16).padStart(2, "0")).join("")}`;
}
function applyExcelTint(baseColor, tint) {
  const rgb = parseHexColor2(baseColor);
  if (!rgb || !Number.isFinite(tint) || tint === 0) {
    return normalizeHexColor2(baseColor);
  }
  const [hue, saturation, lightness] = rgbToHsl2(rgb[0], rgb[1], rgb[2]);
  const nextLightness = tint < 0 ? lightness * (1 + tint) : lightness * (1 - tint) + tint;
  const [nextRed, nextGreen, nextBlue] = hslToRgb2(hue, saturation, Math.max(0, Math.min(1, nextLightness)));
  return rgbToHex2(nextRed, nextGreen, nextBlue);
}
function resolveWorkbookColor(color, themePalette) {
  if (!color) {
    return null;
  }
  const directHex = ["hex", "rgb", "argb"].map((key) => color[key]).find((value) => typeof value === "string" && value.trim().length > 0);
  if (directHex) {
    return normalizeHexColor2(directHex);
  }
  const themeValue = color.theme;
  const numericTheme = typeof themeValue === "number" ? themeValue : typeof themeValue === "string" && themeValue.trim().length > 0 ? Number(themeValue) : Number.NaN;
  const themeColor = Number.isFinite(numericTheme) ? themePalette?.colorsByIndex[numericTheme] ?? null : null;
  if (!themeColor) {
    return null;
  }
  const tintValue = color.tint;
  const tint = typeof tintValue === "number" ? tintValue : typeof tintValue === "string" && tintValue.trim().length > 0 ? Number(tintValue) : Number.NaN;
  return Number.isFinite(tint) ? applyExcelTint(themeColor, tint) : themeColor;
}

// src/images.ts
var REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
var SPREADSHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
var DRAWING_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";
var EMU_PER_PIXEL2 = 9525;
var MIN_COL_WIDTH_PX = 30;
var MIN_ROW_HEIGHT_PX = 16;
var DEFAULT_COL_WIDTH_EMU = 64 * EMU_PER_PIXEL2;
var DEFAULT_ROW_HEIGHT_EMU = 20 * EMU_PER_PIXEL2;
var DEFAULT_COLUMN_CHARACTER_WIDTH_PX = 7;
var columnCharacterWidthCache = /* @__PURE__ */ new Map();
function measureColumnCharacterWidthPx(fontFamily, fontSizePt) {
  const normalizedFamily = typeof fontFamily === "string" && fontFamily.trim().length > 0 ? fontFamily.trim() : "Calibri";
  const normalizedSizePt = typeof fontSizePt === "number" && Number.isFinite(fontSizePt) && fontSizePt > 0 ? fontSizePt : 11;
  const cacheKey = `${normalizedFamily}|${normalizedSizePt}`;
  const cached = columnCharacterWidthCache.get(cacheKey);
  if (cached !== void 0) {
    return cached;
  }
  const fontSizePx = normalizedSizePt * (96 / 72);
  const font = `${fontSizePx}px "${normalizedFamily}"`;
  let width = DEFAULT_COLUMN_CHARACTER_WIDTH_PX;
  try {
    const context = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(32, 32).getContext("2d") : null;
    if (context) {
      context.font = font;
      width = Math.max(1, context.measureText("0").width);
    }
  } catch {
    width = DEFAULT_COLUMN_CHARACTER_WIDTH_PX;
  }
  columnCharacterWidthCache.set(cacheKey, width);
  return width;
}
function sheetColumnWidthToPixels(width, columnCharacterWidthPx = DEFAULT_COLUMN_CHARACTER_WIDTH_PX) {
  if (!Number.isFinite(width) || width <= 0) {
    return MIN_COL_WIDTH_PX;
  }
  const digitWidth = Math.max(1, columnCharacterWidthPx);
  const pixels = width < 1 ? Math.floor(width * (digitWidth + 5) + 0.5) : Math.floor((256 * width + Math.floor(128 / digitWidth)) / 256 * digitWidth);
  return Math.max(MIN_COL_WIDTH_PX, pixels);
}
function buildThemePalette(theme) {
  const themeOrder = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
  const colorsByIndex = {};
  themeOrder.forEach((key, index) => {
    const color = theme.colors.get(key);
    if (color) {
      colorsByIndex[index] = color;
    }
  });
  return {
    colorsByIndex,
    majorLatinFont: theme.majorLatinFont ?? void 0,
    minorLatinFont: theme.minorLatinFont ?? void 0
  };
}
function normalizeArchivePath2(path) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}
function joinArchivePath(...parts) {
  return normalizeArchivePath2(parts.join("/"));
}
function dirname2(path) {
  const normalized = normalizeArchivePath2(path);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash >= 0 ? normalized.slice(0, lastSlash) : "";
}
function resolveArchiveTarget(baseDocumentPath, target) {
  if (!target) {
    return normalizeArchivePath2(baseDocumentPath);
  }
  if (target.startsWith("#")) {
    return target;
  }
  if (target.startsWith("/")) {
    return normalizeArchivePath2(target);
  }
  const baseParts = dirname2(baseDocumentPath).split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      baseParts.pop();
      continue;
    }
    baseParts.push(segment);
  }
  return normalizeArchivePath2(baseParts.join("/"));
}
function relsPathForDocument(documentPath) {
  const baseName = documentPath.split("/").pop();
  const parentDir = dirname2(documentPath);
  return joinArchivePath(parentDir, "_rels", `${baseName}.rels`);
}
function parseXml2(xml) {
  const parser = new DOMParser();
  const document2 = parser.parseFromString(xml, "application/xml");
  if (document2.querySelector("parsererror")) {
    return null;
  }
  return document2;
}
function readArchiveText2(archive, path) {
  const entry = archive[path];
  return entry ? strFromU82(entry) : null;
}
function parseColumnReference(reference) {
  let value = 0;
  for (const character of reference.toUpperCase()) {
    if (character < "A" || character > "Z") {
      return null;
    }
    value = value * 26 + (character.charCodeAt(0) - 64);
  }
  return value > 0 ? value - 1 : null;
}
function parseA1CellReference(reference) {
  const match = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(reference.trim());
  if (!match) {
    return null;
  }
  const col = parseColumnReference(match[1] ?? "");
  const row = Number(match[2] ?? Number.NaN) - 1;
  if (col === null || !Number.isFinite(row) || row < 0) {
    return null;
  }
  return { col, row };
}
function parseA1RangeReference(reference) {
  const [startRef, endRef] = reference.split(":");
  const start = parseA1CellReference(startRef ?? "");
  const end = parseA1CellReference(endRef ?? startRef ?? "");
  return start && end ? { end, start } : null;
}
function stripSheetNameFromFormulaReference(reference) {
  const trimmed = reference.trim();
  const bangIndex = trimmed.lastIndexOf("!");
  return bangIndex >= 0 ? trimmed.slice(bangIndex + 1) : trimmed;
}
function parseFormulaCellReference(reference) {
  const normalized = stripSheetNameFromFormulaReference(reference).split(/\s+/)[0] ?? "";
  return parseA1CellReference(normalized);
}
function parseFormulaRangeReference(reference) {
  return parseA1RangeReference(stripSheetNameFromFormulaReference(reference));
}
function isElementNode2(node) {
  return Boolean(node && node.nodeType === 1);
}
function getLocalElements(parent, localName) {
  return Array.from(parent.getElementsByTagName("*")).filter((node) => isElementNode2(node) && node.localName === localName);
}
function getChildElements(parent, localName) {
  return Array.from(parent.childNodes).filter((node) => isElementNode2(node) && node.localName === localName);
}
function getFirstChild(parent, localName) {
  return getChildElements(parent, localName)[0] ?? null;
}
function getFirstDescendant(parent, localName) {
  return getLocalElements(parent, localName)[0] ?? null;
}
function readFeaturePropertyBagCheckboxComplements(archive) {
  const xml = readArchiveText2(archive, "xl/featurePropertyBag/featurePropertyBag.xml");
  if (!xml) {
    return /* @__PURE__ */ new Set();
  }
  const document2 = parseXml2(xml);
  if (!document2?.documentElement) {
    return /* @__PURE__ */ new Set();
  }
  const bagNodes = getChildElements(document2.documentElement, "bag");
  const bagTypeById = bagNodes.map((node) => node.getAttribute("type") ?? "");
  const checkboxComplementIndices = /* @__PURE__ */ new Set();
  const xfComplementsBag = bagNodes.find((node) => node.getAttribute("type") === "XFComplements") ?? null;
  const mappedBagIds = xfComplementsBag ? getLocalElements(xfComplementsBag, "bagId").map((node) => Number(node.textContent ?? Number.NaN)).filter((value) => Number.isFinite(value)) : [];
  mappedBagIds.forEach((bagId, complementIndex) => {
    const xfComplementBag = bagNodes[bagId];
    if (!xfComplementBag || bagTypeById[bagId] !== "XFComplement") {
      return;
    }
    const xfControlsBagId = getLocalElements(xfComplementBag, "bagId").map((node) => Number(node.textContent ?? Number.NaN)).find((value) => Number.isFinite(value));
    if (xfControlsBagId === void 0) {
      return;
    }
    const xfControlsBag = bagNodes[xfControlsBagId];
    if (!xfControlsBag || bagTypeById[xfControlsBagId] !== "XFControls") {
      return;
    }
    const cellControlBagId = getLocalElements(xfControlsBag, "bagId").map((node) => Number(node.textContent ?? Number.NaN)).find((value) => Number.isFinite(value));
    if (cellControlBagId === void 0) {
      return;
    }
    if (bagTypeById[cellControlBagId] === "Checkbox") {
      checkboxComplementIndices.add(complementIndex);
    }
  });
  return checkboxComplementIndices;
}
function getRelationshipId(element) {
  return element.getAttributeNS(REL_NS, "id") ?? element.getAttribute("r:id") ?? element.getAttribute("id");
}
function parseContentTypes(archive) {
  const xml = readArchiveText2(archive, "[Content_Types].xml");
  const defaultEntries = /* @__PURE__ */ new Map();
  const overrideEntries = /* @__PURE__ */ new Map();
  if (!xml) {
    return { defaultEntries, overrideEntries };
  }
  const document2 = parseXml2(xml);
  if (!document2) {
    return { defaultEntries, overrideEntries };
  }
  for (const defaultNode of getLocalElements(document2, "Default")) {
    const extension = defaultNode.getAttribute("Extension");
    const contentType = defaultNode.getAttribute("ContentType");
    if (extension && contentType) {
      defaultEntries.set(extension.toLowerCase(), contentType);
    }
  }
  for (const overrideNode of getLocalElements(document2, "Override")) {
    const partName = overrideNode.getAttribute("PartName");
    const contentType = overrideNode.getAttribute("ContentType");
    if (partName && contentType) {
      overrideEntries.set(normalizeArchivePath2(partName), contentType);
    }
  }
  return { defaultEntries, overrideEntries };
}
function parseRelationships(archive, relsPath, baseDocumentPath) {
  const xml = readArchiveText2(archive, relsPath);
  const relationships = /* @__PURE__ */ new Map();
  if (!xml) {
    return relationships;
  }
  const document2 = parseXml2(xml);
  if (!document2) {
    return relationships;
  }
  for (const relationshipNode of getLocalElements(document2, "Relationship")) {
    const id = relationshipNode.getAttribute("Id");
    const target = relationshipNode.getAttribute("Target");
    const type = relationshipNode.getAttribute("Type");
    if (!id || !target || !type) {
      continue;
    }
    relationships.set(id, {
      id,
      target: resolveArchiveTarget(baseDocumentPath, target),
      targetMode: relationshipNode.getAttribute("TargetMode"),
      type
    });
  }
  return relationships;
}
function parseWorkbookSheets(archive) {
  const workbookXml = readArchiveText2(archive, "xl/workbook.xml");
  if (!workbookXml) {
    return [];
  }
  const workbookDocument = parseXml2(workbookXml);
  if (!workbookDocument) {
    return [];
  }
  const workbookRelationships = parseRelationships(archive, "xl/_rels/workbook.xml.rels", "xl/workbook.xml");
  const sheets2 = [];
  for (const sheetNode of getLocalElements(workbookDocument, "sheet")) {
    const relationshipId = getRelationshipId(sheetNode);
    if (!relationshipId) {
      continue;
    }
    const relationship = workbookRelationships.get(relationshipId);
    if (!relationship) {
      continue;
    }
    sheets2.push({
      name: sheetNode.getAttribute("name") ?? `Sheet ${sheets2.length + 1}`,
      path: relationship.target
    });
  }
  return sheets2;
}
function parseWorkbookTheme(archive) {
  const defaultTheme = {
    colors: /* @__PURE__ */ new Map([
      ["accent1", "#5b9bd5"],
      ["accent2", "#ed7d31"],
      ["accent3", "#a5a5a5"],
      ["accent4", "#ffc000"],
      ["accent5", "#4472c4"],
      ["accent6", "#70ad47"],
      ["bg1", "#ffffff"],
      ["bg2", "#e7e6e6"],
      ["dk1", "#000000"],
      ["dk2", "#6e747a"],
      ["folHlink", "#993366"],
      ["hlink", "#085296"],
      ["lt1", "#ffffff"],
      ["lt2", "#e7e6e6"],
      ["tx1", "#000000"],
      ["tx2", "#6e747a"]
    ]),
    majorLatinFont: null,
    minorLatinFont: null
  };
  const themeXml = readArchiveText2(archive, "xl/theme/theme1.xml");
  if (!themeXml) {
    return defaultTheme;
  }
  const themeDocument = parseXml2(themeXml);
  if (!themeDocument) {
    return defaultTheme;
  }
  const colors = new Map(defaultTheme.colors);
  const colorSchemeNode = getLocalElements(themeDocument, "clrScheme")[0] ?? null;
  if (colorSchemeNode) {
    for (const colorNode of Array.from(colorSchemeNode.childNodes).filter(isElementNode2)) {
      const key = colorNode.localName;
      const srgbNode = getFirstChild(colorNode, "srgbClr");
      const sysNode = getFirstChild(colorNode, "sysClr");
      const hex = srgbNode?.getAttribute("val") ?? sysNode?.getAttribute("lastClr");
      if (hex) {
        colors.set(key, normalizeHexColor3(hex));
      }
    }
  }
  const fontSchemeNode = getLocalElements(themeDocument, "fontScheme")[0] ?? null;
  const majorLatinFont = getFirstChild(getFirstChild(fontSchemeNode, "majorFont"), "latin")?.getAttribute("typeface") ?? null;
  const minorLatinFont = getFirstChild(getFirstChild(fontSchemeNode, "minorFont"), "latin")?.getAttribute("typeface") ?? null;
  colors.set("bg1", colors.get("lt1") ?? defaultTheme.colors.get("bg1") ?? "#ffffff");
  colors.set("tx1", colors.get("dk1") ?? defaultTheme.colors.get("tx1") ?? "#000000");
  colors.set("bg2", colors.get("lt2") ?? defaultTheme.colors.get("bg2") ?? "#e7e6e6");
  colors.set("tx2", colors.get("dk2") ?? defaultTheme.colors.get("tx2") ?? "#6e747a");
  return {
    colors,
    majorLatinFont,
    minorLatinFont
  };
}
function parseSpreadsheetColor(node) {
  if (!node) {
    return void 0;
  }
  const color = {};
  const rgb = node.getAttribute("rgb");
  const theme = node.getAttribute("theme");
  const tint = node.getAttribute("tint");
  const indexed = node.getAttribute("indexed");
  if (rgb) {
    color.rgb = normalizeHexColor3(rgb);
  }
  if (theme !== null) {
    color.theme = Number(theme);
  }
  if (tint !== null) {
    color.tint = Number(tint);
  }
  if (indexed !== null) {
    color.indexed = Number(indexed);
  }
  return Object.keys(color).length > 0 ? color : void 0;
}
function hasEnabledSpreadsheetFlag(node) {
  if (!node) {
    return false;
  }
  const value = node.getAttribute("val");
  return value === null || value !== "0" && value !== "false";
}
function parseSheetSparklines(document2, themePalette) {
  const sparklines = [];
  for (const groupNode of getLocalElements(document2, "sparklineGroup")) {
    const rawType = groupNode.getAttribute("type");
    const sparklineType = rawType === "column" ? "column" : rawType === "stacked" ? "winLoss" : "line";
    const markersNode = getFirstChild(groupNode, "markers");
    const negativeNode = getFirstChild(groupNode, "negative");
    const colorSeries = resolveWorkbookColor(parseSpreadsheetColor(getFirstChild(groupNode, "colorSeries")), themePalette);
    const colorNegative = resolveWorkbookColor(parseSpreadsheetColor(getFirstChild(groupNode, "colorNegative")), themePalette);
    const colorMarkers = resolveWorkbookColor(parseSpreadsheetColor(getFirstChild(groupNode, "colorMarkers")), themePalette);
    const colorFirst = resolveWorkbookColor(parseSpreadsheetColor(getFirstChild(groupNode, "colorFirst")), themePalette);
    const colorLast = resolveWorkbookColor(parseSpreadsheetColor(getFirstChild(groupNode, "colorLast")), themePalette);
    const colorHigh = resolveWorkbookColor(parseSpreadsheetColor(getFirstChild(groupNode, "colorHigh")), themePalette);
    const colorLow = resolveWorkbookColor(parseSpreadsheetColor(getFirstChild(groupNode, "colorLow")), themePalette);
    const sparklineCollectionNode = getFirstChild(groupNode, "sparklines");
    if (!sparklineCollectionNode) {
      continue;
    }
    for (const sparklineNode of getChildElements(sparklineCollectionNode, "sparkline")) {
      const formula = getFirstChild(sparklineNode, "f")?.textContent ?? "";
      const targetReference = getFirstChild(sparklineNode, "sqref")?.textContent ?? "";
      const range = parseFormulaRangeReference(formula);
      const target = parseFormulaCellReference(targetReference);
      if (!range || !target) {
        continue;
      }
      sparklines.push({
        color: colorSeries ?? void 0,
        firstColor: colorFirst ?? void 0,
        highColor: colorHigh ?? void 0,
        lastColor: colorLast ?? void 0,
        lowColor: colorLow ?? void 0,
        markerColor: colorMarkers ?? void 0,
        markers: hasEnabledSpreadsheetFlag(markersNode),
        negative: hasEnabledSpreadsheetFlag(negativeNode),
        negativeColor: colorNegative ?? void 0,
        range,
        target,
        type: sparklineType
      });
    }
  }
  return sparklines;
}
function parseSpreadsheetFont(node) {
  if (!node) {
    return void 0;
  }
  const font = {};
  const size = getFirstChild(node, "sz")?.getAttribute("val");
  const name = getFirstChild(node, "name")?.getAttribute("val");
  const family = getFirstChild(node, "family")?.getAttribute("val");
  const scheme = getFirstChild(node, "scheme")?.getAttribute("val");
  const charset = getFirstChild(node, "charset")?.getAttribute("val");
  const verticalAlign = getFirstChild(node, "vertAlign")?.getAttribute("val");
  const color = parseSpreadsheetColor(getFirstChild(node, "color"));
  if (hasEnabledSpreadsheetFlag(getFirstChild(node, "b"))) {
    font.bold = true;
  }
  if (hasEnabledSpreadsheetFlag(getFirstChild(node, "i"))) {
    font.italic = true;
  }
  if (hasEnabledSpreadsheetFlag(getFirstChild(node, "strike"))) {
    font.strikethrough = true;
  }
  if (getFirstChild(node, "u")) {
    font.underline = getFirstChild(node, "u")?.getAttribute("val") ?? "single";
  }
  if (size !== null && size !== void 0) {
    font.size = Number(size);
  }
  if (name) {
    font.name = name;
  }
  if (family !== null && family !== void 0) {
    font.family = Number(family);
  }
  if (scheme) {
    font.scheme = scheme;
  }
  if (charset !== null && charset !== void 0) {
    font.charset = Number(charset);
  }
  if (verticalAlign) {
    font.verticalAlign = verticalAlign;
  }
  if (hasEnabledSpreadsheetFlag(getFirstChild(node, "shadow"))) {
    font.shadow = true;
  }
  if (hasEnabledSpreadsheetFlag(getFirstChild(node, "outline"))) {
    font.outline = true;
  }
  if (hasEnabledSpreadsheetFlag(getFirstChild(node, "condense"))) {
    font.condense = true;
  }
  if (hasEnabledSpreadsheetFlag(getFirstChild(node, "extend"))) {
    font.extend = true;
  }
  if (color) {
    font.color = color;
  }
  return Object.keys(font).length > 0 ? font : void 0;
}
function parseSpreadsheetFill(node) {
  if (!node) {
    return void 0;
  }
  const gradientFill = getFirstChild(node, "gradientFill");
  if (gradientFill) {
    const stops = Array.from(gradientFill.childNodes).filter(isElementNode2).filter((child) => child.localName === "stop").map((stopNode) => ({
      color: parseSpreadsheetColor(Array.from(stopNode.childNodes).find(isElementNode2) ?? null),
      position: Number(stopNode.getAttribute("position") ?? Number.NaN)
    })).filter((stop) => stop.color && Number.isFinite(stop.position));
    if (stops.length > 0) {
      return {
        degree: Number(gradientFill.getAttribute("degree") ?? 0),
        fillType: "gradient",
        gradientType: gradientFill.getAttribute("type") ?? "linear",
        stops
      };
    }
  }
  const patternFill = getFirstChild(node, "patternFill");
  if (!patternFill) {
    return void 0;
  }
  const patternType = patternFill.getAttribute("patternType") ?? "none";
  const foreground = parseSpreadsheetColor(getFirstChild(patternFill, "fgColor"));
  const background = parseSpreadsheetColor(getFirstChild(patternFill, "bgColor"));
  const solidColor = foreground ?? background;
  if (patternType === "solid" && solidColor) {
    return {
      color: solidColor,
      fillType: "solid"
    };
  }
  if ((patternType === "none" || patternType === "gray125") && (foreground || background)) {
    return {
      background,
      fillType: "pattern",
      foreground,
      patternType
    };
  }
  if (patternType !== "none" && patternType !== "gray125" && (foreground || background)) {
    return {
      background,
      fillType: "pattern",
      foreground,
      patternType
    };
  }
  return void 0;
}
function parseSpreadsheetBorderEdge(node) {
  if (!node) {
    return void 0;
  }
  const style = node.getAttribute("style");
  const color = parseSpreadsheetColor(getFirstChild(node, "color"));
  if (!style || style === "none") {
    return void 0;
  }
  return {
    color,
    style
  };
}
function parseSpreadsheetBorder(node) {
  if (!node) {
    return void 0;
  }
  const border = {};
  ["top", "right", "bottom", "left", "horizontal", "vertical"].forEach((edge) => {
    const parsedEdge = parseSpreadsheetBorderEdge(getFirstChild(node, edge));
    if (parsedEdge) {
      border[edge] = parsedEdge;
    }
  });
  return Object.keys(border).length > 0 ? border : void 0;
}
function parseSpreadsheetAlignment(node) {
  if (!node) {
    return void 0;
  }
  const alignment = {};
  const horizontal = node.getAttribute("horizontal");
  const vertical = node.getAttribute("vertical");
  const wrapText = node.getAttribute("wrapText");
  const indent = node.getAttribute("indent");
  const shrinkToFit = node.getAttribute("shrinkToFit");
  const textRotation = node.getAttribute("textRotation");
  if (horizontal) {
    alignment.horizontal = horizontal;
  }
  if (vertical) {
    alignment.vertical = vertical;
  }
  if (wrapText !== null) {
    alignment.wrapText = wrapText === "1";
  }
  if (shrinkToFit !== null) {
    alignment.shrinkToFit = shrinkToFit === "1";
  }
  if (indent !== null) {
    alignment.indent = Number(indent);
  }
  if (textRotation !== null) {
    const parsedRotation = Number(textRotation);
    if (Number.isFinite(parsedRotation)) {
      alignment.textRotation = parsedRotation;
    }
  }
  return Object.keys(alignment).length > 0 ? alignment : void 0;
}
function parseDifferentialStyle(node) {
  if (!node) {
    return {};
  }
  const style = {};
  const font = parseSpreadsheetFont(getFirstChild(node, "font"));
  const fill = parseSpreadsheetFill(getFirstChild(node, "fill"));
  const border = parseSpreadsheetBorder(getFirstChild(node, "border"));
  const alignment = parseSpreadsheetAlignment(getFirstChild(node, "alignment"));
  if (font) {
    style.font = font;
  }
  if (fill) {
    style.fill = fill;
  }
  if (border) {
    style.border = border;
  }
  if (alignment) {
    style.alignment = alignment;
  }
  return style;
}
function parseResolvedXfStyle(xfNode, fonts, fills, borders, checkboxComplementIndices) {
  const style = {};
  const fontId = Number(xfNode.getAttribute("fontId") ?? Number.NaN);
  const fillId = Number(xfNode.getAttribute("fillId") ?? Number.NaN);
  const borderId = Number(xfNode.getAttribute("borderId") ?? Number.NaN);
  const alignment = parseSpreadsheetAlignment(getFirstChild(xfNode, "alignment"));
  if (Number.isFinite(fontId) && fonts[fontId]) {
    style.font = fonts[fontId];
  }
  if (Number.isFinite(fillId) && fills[fillId]) {
    style.fill = fills[fillId];
  }
  if (Number.isFinite(borderId) && borders[borderId]) {
    style.border = borders[borderId];
  }
  if (alignment) {
    style.alignment = alignment;
  }
  const xfComplementNode = getFirstDescendant(xfNode, "xfComplement");
  const xfComplementIndex = Number(xfComplementNode?.getAttribute("i") ?? Number.NaN);
  if (Number.isFinite(xfComplementIndex) && checkboxComplementIndices?.has(xfComplementIndex)) {
    style.cellControl = { kind: "checkbox" };
  }
  return style;
}
function parseWorkbookStyles(archive) {
  const xml = readArchiveText2(archive, "xl/styles.xml");
  if (!xml) {
    return {
      defaultFont: null,
      namedCellStyleByName: {},
      styleById: {},
      tableStyleByName: {}
    };
  }
  const document2 = parseXml2(xml);
  if (!document2) {
    return {
      defaultFont: null,
      namedCellStyleByName: {},
      styleById: {},
      tableStyleByName: {}
    };
  }
  const fontsNode = getFirstDescendant(document2, "fonts");
  const fillsNode = getFirstDescendant(document2, "fills");
  const bordersNode = getFirstDescendant(document2, "borders");
  const cellStyleXfsNode = getFirstDescendant(document2, "cellStyleXfs");
  const cellStylesNode = getFirstDescendant(document2, "cellStyles");
  const cellXfsNode = getFirstDescendant(document2, "cellXfs");
  const dxfsNode = getFirstDescendant(document2, "dxfs");
  const tableStylesNode = getFirstDescendant(document2, "tableStyles");
  if (!cellXfsNode) {
    return {
      defaultFont: null,
      namedCellStyleByName: {},
      styleById: {},
      tableStyleByName: {}
    };
  }
  const checkboxComplementIndices = readFeaturePropertyBagCheckboxComplements(archive);
  const fonts = getChildElements(fontsNode ?? document2.documentElement, "font").map((node) => parseSpreadsheetFont(node));
  const fills = getChildElements(fillsNode ?? document2.documentElement, "fill").map((node) => parseSpreadsheetFill(node));
  const borders = getChildElements(bordersNode ?? document2.documentElement, "border").map((node) => parseSpreadsheetBorder(node));
  const differentialStyles = getChildElements(dxfsNode ?? document2.documentElement, "dxf").map((node) => parseDifferentialStyle(node));
  const cellStyleXfs = getChildElements(cellStyleXfsNode ?? document2.documentElement, "xf").map(
    (node) => parseResolvedXfStyle(node, fonts, fills, borders, checkboxComplementIndices)
  );
  const namedCellStyleByName = {};
  const styleById = {};
  const tableStyleByName = {};
  getChildElements(cellXfsNode, "xf").forEach((xfNode, index) => {
    styleById[index] = parseResolvedXfStyle(xfNode, fonts, fills, borders, checkboxComplementIndices);
  });
  getChildElements(cellStylesNode ?? document2.documentElement, "cellStyle").forEach((cellStyleNode) => {
    const name = cellStyleNode.getAttribute("name");
    const xfId = Number(cellStyleNode.getAttribute("xfId") ?? Number.NaN);
    if (!name || !Number.isFinite(xfId)) {
      return;
    }
    const resolvedStyle = cellStyleXfs[xfId];
    if (resolvedStyle) {
      namedCellStyleByName[name] = resolvedStyle;
    }
  });
  getChildElements(tableStylesNode ?? document2.documentElement, "tableStyle").forEach((tableStyleNode) => {
    const name = tableStyleNode.getAttribute("name");
    if (!name) {
      return;
    }
    const elements = {};
    getChildElements(tableStyleNode, "tableStyleElement").forEach((elementNode) => {
      const type = elementNode.getAttribute("type");
      const dxfId = Number(elementNode.getAttribute("dxfId") ?? Number.NaN);
      if (!type || !Number.isFinite(dxfId)) {
        return;
      }
      const differentialStyle = differentialStyles[dxfId];
      if (differentialStyle) {
        elements[type] = differentialStyle;
      }
    });
    tableStyleByName[name] = elements;
  });
  const normalFont = namedCellStyleByName.Normal?.font ?? styleById[0]?.font ?? fonts[0];
  const defaultFont = normalFont ? {
    family: typeof normalFont.name === "string" ? normalFont.name : void 0,
    sizePt: typeof normalFont.size === "number" ? normalFont.size : void 0
  } : null;
  return {
    defaultFont,
    namedCellStyleByName,
    styleById,
    tableStyleByName
  };
}
function parseWorkbookTableMetadata(archive, workbookSheets) {
  return workbookSheets.map((sheet) => {
    const sheetRelationships = parseRelationships(archive, relsPathForDocument(sheet.path), sheet.path);
    const sheetXml = readArchiveText2(archive, sheet.path);
    if (!sheetXml) {
      return [];
    }
    const sheetDocument = parseXml2(sheetXml);
    if (!sheetDocument) {
      return [];
    }
    return getLocalElements(sheetDocument, "tablePart").flatMap((tablePartNode) => {
      const relationshipId = getRelationshipId(tablePartNode);
      if (!relationshipId) {
        return [];
      }
      const relationship = sheetRelationships.get(relationshipId);
      if (!relationship) {
        return [];
      }
      const tableXml = readArchiveText2(archive, relationship.target);
      if (!tableXml) {
        return [];
      }
      const tableDocument = parseXml2(tableXml);
      const tableNode = tableDocument?.documentElement;
      if (!tableNode || tableNode.localName !== "table") {
        return [];
      }
      return [{
        displayName: tableNode.getAttribute("displayName") ?? void 0,
        headerRowCount: parseWorkbookTableCount(tableNode.getAttribute("headerRowCount"), 1),
        headerRowCellStyle: tableNode.getAttribute("headerRowCellStyle") ?? void 0,
        name: tableNode.getAttribute("name") ?? void 0,
        reference: tableNode.getAttribute("ref") ?? void 0,
        totalsRowCount: parseWorkbookTableCount(tableNode.getAttribute("totalsRowCount"), 0),
        totalsRowShown: parseWorkbookTableBoolean(tableNode.getAttribute("totalsRowShown"), false)
      }];
    });
  });
}
function parseWorkbookTableCount(value, fallback) {
  if (value === null) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function parseWorkbookTableBoolean(value, fallback) {
  if (value === null) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "") {
    return false;
  }
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  return fallback;
}
function parseSqrefRanges(sqref) {
  if (!sqref) {
    return [];
  }
  return sqref.trim().split(/\s+/).flatMap((reference) => {
    const range = parseA1RangeReference(reference);
    return range ? [range] : [];
  });
}
function parseConditionalFormatValueObject(node) {
  if (!node) {
    return null;
  }
  const type = node.getAttribute("type");
  if (!type) {
    return null;
  }
  const rawValue = node.getAttribute("val") ?? getFirstChild(node, "f")?.textContent ?? void 0;
  const numericValue = rawValue !== void 0 ? Number(rawValue) : Number.NaN;
  return {
    type,
    value: Number.isFinite(numericValue) ? numericValue : void 0
  };
}
function parseSpreadsheetBooleanAttribute(node, name) {
  if (!node) {
    return void 0;
  }
  const value = node.getAttribute(name);
  if (value === null) {
    return void 0;
  }
  return value !== "0" && value !== "false";
}
function parseStandardConditionalFormatRule(cfRuleNode, ranges) {
  const type = cfRuleNode.getAttribute("type");
  const rawPriority = Number(cfRuleNode.getAttribute("priority") ?? Number.NaN);
  const priority = Number.isFinite(rawPriority) ? rawPriority : Number.MAX_SAFE_INTEGER;
  if (type === "colorScale") {
    const colorScaleNode = getFirstChild(cfRuleNode, "colorScale");
    if (!colorScaleNode) {
      return null;
    }
    const cfvos = getChildElements(colorScaleNode, "cfvo").map((node) => parseConditionalFormatValueObject(node)).filter((value) => Boolean(value));
    const colors = getChildElements(colorScaleNode, "color").map((node) => parseSpreadsheetColor(node)).filter((value) => Boolean(value));
    if (cfvos.length === 0 || colors.length === 0) {
      return null;
    }
    return {
      cfvos,
      colors,
      kind: "colorScale",
      priority,
      ranges
    };
  }
  if (type === "dataBar") {
    const dataBarNode = getFirstChild(cfRuleNode, "dataBar");
    if (!dataBarNode) {
      return null;
    }
    const cfvos = getChildElements(dataBarNode, "cfvo").map((node) => parseConditionalFormatValueObject(node)).filter((value) => Boolean(value));
    if (cfvos.length === 0) {
      return null;
    }
    const extId = getFirstDescendant(cfRuleNode, "id")?.textContent?.trim() || void 0;
    return {
      cfvos,
      color: parseSpreadsheetColor(getFirstChild(dataBarNode, "color")),
      kind: "dataBar",
      priority,
      ranges,
      id: extId
    };
  }
  if (type === "iconSet") {
    const iconSetNode = getFirstChild(cfRuleNode, "iconSet");
    if (!iconSetNode) {
      return null;
    }
    const iconSetName = iconSetNode.getAttribute("iconSet");
    const cfvos = getChildElements(iconSetNode, "cfvo").map((node) => parseConditionalFormatValueObject(node)).filter((value) => Boolean(value));
    if (!iconSetName || cfvos.length === 0) {
      return null;
    }
    return {
      cfvos,
      icons: cfvos.map((_, index) => ({
        iconId: index,
        iconSet: iconSetName
      })),
      kind: "iconSet",
      priority,
      ranges,
      reverse: parseSpreadsheetBooleanAttribute(iconSetNode, "reverse"),
      showValue: parseSpreadsheetBooleanAttribute(iconSetNode, "showValue")
    };
  }
  return null;
}
function parseExtendedConditionalFormatRule(cfRuleNode, ranges) {
  const type = cfRuleNode.getAttribute("type");
  const ruleId = cfRuleNode.getAttribute("id") ?? void 0;
  const rawPriority = Number(cfRuleNode.getAttribute("priority") ?? Number.NaN);
  const priority = Number.isFinite(rawPriority) ? rawPriority : Number.MAX_SAFE_INTEGER;
  if (type === "dataBar") {
    const dataBarNode = getFirstChild(cfRuleNode, "dataBar");
    if (!dataBarNode) {
      return null;
    }
    const cfvos = getChildElements(dataBarNode, "cfvo").map((node) => parseConditionalFormatValueObject(node)).filter((value) => Boolean(value));
    if (cfvos.length === 0) {
      return null;
    }
    return {
      axisColor: parseSpreadsheetColor(getFirstChild(dataBarNode, "axisColor")),
      border: parseSpreadsheetBooleanAttribute(dataBarNode, "border"),
      borderColor: parseSpreadsheetColor(getFirstChild(dataBarNode, "borderColor")),
      cfvos,
      color: parseSpreadsheetColor(getFirstChild(dataBarNode, "fillColor")),
      gradient: parseSpreadsheetBooleanAttribute(dataBarNode, "gradient"),
      kind: "dataBar",
      maxLength: Number(dataBarNode.getAttribute("maxLength") ?? Number.NaN),
      minLength: Number(dataBarNode.getAttribute("minLength") ?? Number.NaN),
      negativeBarBorderColorSameAsPositive: parseSpreadsheetBooleanAttribute(dataBarNode, "negativeBarBorderColorSameAsPositive"),
      negativeBorderColor: parseSpreadsheetColor(getFirstChild(dataBarNode, "negativeBorderColor")),
      negativeFillColor: parseSpreadsheetColor(getFirstChild(dataBarNode, "negativeFillColor")),
      priority,
      ranges,
      showValue: parseSpreadsheetBooleanAttribute(dataBarNode, "showValue"),
      id: ruleId
    };
  }
  if (type === "iconSet") {
    const iconSetNode = getFirstChild(cfRuleNode, "iconSet");
    if (!iconSetNode) {
      return null;
    }
    const cfvos = getChildElements(iconSetNode, "cfvo").map((node) => parseConditionalFormatValueObject(node)).filter((value) => Boolean(value));
    const icons = getChildElements(iconSetNode, "cfIcon").map((iconNode) => {
      const iconSet = iconNode.getAttribute("iconSet");
      const rawIconId = Number(iconNode.getAttribute("iconId") ?? Number.NaN);
      if (!iconSet || !Number.isFinite(rawIconId)) {
        return null;
      }
      return {
        iconId: rawIconId,
        iconSet
      };
    }).filter((icon) => Boolean(icon));
    if (cfvos.length === 0 || icons.length === 0) {
      return null;
    }
    return {
      cfvos,
      icons,
      kind: "iconSet",
      priority,
      ranges,
      reverse: parseSpreadsheetBooleanAttribute(iconSetNode, "reverse"),
      showValue: parseSpreadsheetBooleanAttribute(iconSetNode, "showValue"),
      id: ruleId
    };
  }
  return null;
}
function mergeConditionalFormatRule(baseRule, extendedRule) {
  if (baseRule.kind !== extendedRule.kind) {
    return baseRule;
  }
  if (baseRule.kind === "colorScale" && extendedRule.kind === "colorScale") {
    return {
      ...baseRule,
      ...extendedRule,
      cfvos: extendedRule.cfvos.length > 0 ? extendedRule.cfvos : baseRule.cfvos,
      colors: extendedRule.colors.length > 0 ? extendedRule.colors : baseRule.colors,
      priority: Number.isFinite(extendedRule.priority) ? extendedRule.priority : baseRule.priority,
      ranges: extendedRule.ranges.length > 0 ? extendedRule.ranges : baseRule.ranges
    };
  }
  if (baseRule.kind === "dataBar" && extendedRule.kind === "dataBar") {
    const merged = {
      ...baseRule,
      ...extendedRule,
      axisColor: extendedRule.axisColor ?? baseRule.axisColor,
      border: extendedRule.border ?? baseRule.border,
      cfvos: extendedRule.cfvos.length > 0 ? extendedRule.cfvos : baseRule.cfvos,
      color: extendedRule.color ?? baseRule.color,
      negativeBarBorderColorSameAsPositive: extendedRule.negativeBarBorderColorSameAsPositive ?? baseRule.negativeBarBorderColorSameAsPositive,
      negativeBorderColor: extendedRule.negativeBorderColor ?? baseRule.negativeBorderColor,
      negativeFillColor: extendedRule.negativeFillColor ?? baseRule.negativeFillColor,
      priority: Number.isFinite(extendedRule.priority) ? extendedRule.priority : baseRule.priority,
      ranges: extendedRule.ranges.length > 0 ? extendedRule.ranges : baseRule.ranges
    };
    return merged;
  }
  if (baseRule.kind === "iconSet" && extendedRule.kind === "iconSet") {
    const merged = {
      ...baseRule,
      ...extendedRule,
      cfvos: extendedRule.cfvos.length > 0 ? extendedRule.cfvos : baseRule.cfvos,
      icons: extendedRule.icons.length > 0 ? extendedRule.icons : baseRule.icons,
      priority: Number.isFinite(extendedRule.priority) ? extendedRule.priority : baseRule.priority,
      ranges: extendedRule.ranges.length > 0 ? extendedRule.ranges : baseRule.ranges
    };
    return merged;
  }
  return baseRule;
}
function parseConditionalFormatRules(document2) {
  const standardRules = [];
  const extendedRules = [];
  getLocalElements(document2, "conditionalFormatting").forEach((conditionalFormattingNode) => {
    const isExtended = conditionalFormattingNode.namespaceURI !== SPREADSHEET_NS;
    const ranges = isExtended ? parseSqrefRanges(getFirstChild(conditionalFormattingNode, "sqref")?.textContent ?? "") : parseSqrefRanges(conditionalFormattingNode.getAttribute("sqref"));
    getChildElements(conditionalFormattingNode, "cfRule").forEach((cfRuleNode) => {
      const parsedRule = isExtended ? parseExtendedConditionalFormatRule(cfRuleNode, ranges) : parseStandardConditionalFormatRule(cfRuleNode, ranges);
      if (parsedRule) {
        if (isExtended) {
          extendedRules.push(parsedRule);
        } else {
          standardRules.push(parsedRule);
        }
      }
    });
  });
  const mergedRules = [];
  const usedExtendedRuleIds = /* @__PURE__ */ new Set();
  const extendedRulesById = new Map(
    extendedRules.filter((rule) => typeof rule.id === "string" && rule.id.length > 0).map((rule) => [rule.id, rule])
  );
  standardRules.forEach((rule) => {
    const matchingExtendedRule = rule.id ? extendedRulesById.get(rule.id) : void 0;
    if (matchingExtendedRule) {
      usedExtendedRuleIds.add(rule.id);
      mergedRules.push(mergeConditionalFormatRule(rule, matchingExtendedRule));
      return;
    }
    mergedRules.push(rule);
  });
  extendedRules.forEach((rule) => {
    if (rule.id && usedExtendedRuleIds.has(rule.id)) {
      return;
    }
    mergedRules.push(rule);
  });
  return mergedRules.map((rule) => {
    const nextRule = { ...rule };
    delete nextRule.id;
    return nextRule;
  }).filter((rule) => rule.ranges.length > 0).sort((left, right) => left.priority - right.priority);
}
function parseSheetState(archive, path, options) {
  const xml = readArchiveText2(archive, path);
  if (!xml) {
    return null;
  }
  const document2 = parseXml2(xml);
  if (!document2) {
    return null;
  }
  const includeCachedFormulaValues = options?.includeCachedFormulaValues ?? true;
  const cachedFormulaValues = {};
  const conditionalFormatRules = parseConditionalFormatRules(document2);
  const sparklines = parseSheetSparklines(document2, options?.themePalette);
  const sheetFormatNode = getLocalElements(document2, "sheetFormatPr")[0] ?? null;
  const sheetViewNode = getLocalElements(document2, "sheetView")[0] ?? null;
  const rowHeightOverridesPx = {};
  const colWidthOverridesPx = {};
  const rowStyleIds = {};
  const colStyleIds = {};
  const hiddenRows = /* @__PURE__ */ new Set();
  const hiddenCols = /* @__PURE__ */ new Set();
  let hasHorizontalMerges = false;
  let hasVerticalMerges = false;
  let maxHorizontalMergeEndCol = -1;
  let maxVerticalMergeEndRow = -1;
  let minContentCol = Number.POSITIVE_INFINITY;
  let minContentRow = Number.POSITIVE_INFINITY;
  let maxContentCol = -1;
  let maxContentRow = -1;
  const columnWidthCharacterWidthPx = measureColumnCharacterWidthPx(
    options?.defaultFont?.family,
    options?.defaultFont?.sizePt
  );
  const defaultRowHeight = Number(sheetFormatNode?.getAttribute("defaultRowHeight") ?? 15);
  const defaultColWidth = Number(
    sheetFormatNode?.getAttribute("defaultColWidth") ?? sheetFormatNode?.getAttribute("baseColWidth") ?? 8.43
  );
  const rawZoomScale = Number(
    sheetViewNode?.getAttribute("zoomScale") ?? sheetViewNode?.getAttribute("zoomScaleNormal") ?? Number.NaN
  );
  const zoomScale = Number.isFinite(rawZoomScale) && rawZoomScale > 0 ? rawZoomScale : 100;
  const trackContentCell = (cellRef) => {
    if (!cellRef) {
      return;
    }
    const cell = parseA1CellReference(cellRef);
    if (!cell) {
      return;
    }
    minContentCol = Math.min(minContentCol, cell.col);
    minContentRow = Math.min(minContentRow, cell.row);
    maxContentCol = Math.max(maxContentCol, cell.col);
    maxContentRow = Math.max(maxContentRow, cell.row);
  };
  const isMeaningfulCellNode = (cellNode) => {
    if (getFirstChild(cellNode, "f") || getFirstChild(cellNode, "is")) {
      return true;
    }
    const valueNode = getFirstChild(cellNode, "v");
    return Boolean(valueNode && (valueNode.textContent ?? "").length > 0);
  };
  getLocalElements(document2, "row").forEach((rowNode) => {
    const rowIndex = Number(rowNode.getAttribute("r") ?? 0) - 1;
    const height = Number(rowNode.getAttribute("ht") ?? Number.NaN);
    const styleId = Number(rowNode.getAttribute("s") ?? Number.NaN);
    const isHidden = (rowNode.getAttribute("hidden") ?? "0") === "1";
    if (rowIndex >= 0 && Number.isFinite(height)) {
      rowHeightOverridesPx[rowIndex] = Math.max(MIN_ROW_HEIGHT_PX, Math.round(height * 1.33));
    }
    if (rowIndex >= 0 && Number.isFinite(styleId)) {
      rowStyleIds[rowIndex] = styleId;
    }
    if (rowIndex >= 0 && isHidden) {
      hiddenRows.add(rowIndex);
    }
    getChildElements(rowNode, "c").forEach((cellNode) => {
      const cellRef = cellNode.getAttribute("r");
      if (isMeaningfulCellNode(cellNode)) {
        trackContentCell(cellRef);
      }
      if (includeCachedFormulaValues) {
        const formulaNode = getFirstChild(cellNode, "f");
        const valueNode = getFirstChild(cellNode, "v");
        if (formulaNode && valueNode && cellRef) {
          cachedFormulaValues[cellRef] = valueNode.textContent ?? "";
        }
      }
    });
  });
  getLocalElements(document2, "mergeCell").forEach((mergeNode) => {
    const reference = mergeNode.getAttribute("ref");
    const range = reference ? parseA1RangeReference(reference) : null;
    if (!range) {
      return;
    }
    if (range.end.col > range.start.col) {
      hasHorizontalMerges = true;
      maxHorizontalMergeEndCol = Math.max(maxHorizontalMergeEndCol, range.end.col);
    }
    if (range.end.row > range.start.row) {
      hasVerticalMerges = true;
      maxVerticalMergeEndRow = Math.max(maxVerticalMergeEndRow, range.end.row);
    }
  });
  const maxMetadataCol = Math.max(maxContentCol, maxHorizontalMergeEndCol, 0) + 256;
  getLocalElements(document2, "col").forEach((colNode) => {
    const min = Number(colNode.getAttribute("min") ?? 0) - 1;
    const max = Number(colNode.getAttribute("max") ?? 0) - 1;
    const width = Number(colNode.getAttribute("width") ?? Number.NaN);
    const styleId = Number(colNode.getAttribute("style") ?? Number.NaN);
    const isHidden = (colNode.getAttribute("hidden") ?? "0") === "1";
    if (!Number.isFinite(width)) {
      if (!Number.isFinite(styleId)) {
        return;
      }
    }
    for (let col = min; col <= Math.min(max, maxMetadataCol); col += 1) {
      if (col >= 0) {
        if (Number.isFinite(width)) {
          const widthPx = sheetColumnWidthToPixels(width, columnWidthCharacterWidthPx);
          colWidthOverridesPx[col] = widthPx;
        }
        if (Number.isFinite(styleId)) {
          colStyleIds[col] = styleId;
        }
        if (isHidden) {
          hiddenCols.add(col);
        }
      }
    }
  });
  return {
    cachedFormulaValues,
    columnWidthCharacterWidthPx,
    colWidthOverridesPx,
    colStyleIds,
    conditionalFormatRules,
    defaultColWidthPx: sheetColumnWidthToPixels(defaultColWidth, columnWidthCharacterWidthPx),
    defaultRowHeightPx: Math.max(MIN_ROW_HEIGHT_PX, Math.round(defaultRowHeight * 1.33)),
    hasHorizontalMerges,
    hasVerticalMerges,
    maxHorizontalMergeEndCol,
    maxVerticalMergeEndRow,
    maxContentCol,
    maxContentRow,
    minContentCol: Number.isFinite(minContentCol) ? minContentCol : -1,
    minContentRow: Number.isFinite(minContentRow) ? minContentRow : -1,
    hiddenCols: [...hiddenCols].sort((left, right) => left - right),
    hiddenRows: [...hiddenRows].sort((left, right) => left - right),
    rowHeightOverridesPx,
    rowStyleIds,
    showGridLines: (sheetViewNode?.getAttribute("showGridLines") ?? "1") !== "0",
    sparklines,
    zoomScale
  };
}
function normalizeHexColor3(value) {
  const hex = value.replace(/^#/, "");
  if (hex.length === 8) {
    return `#${hex.slice(2).toLowerCase()}`;
  }
  if (hex.length === 6) {
    return `#${hex.toLowerCase()}`;
  }
  return "#000000";
}
function parseWorkbookStructureAssetsFromArchive(archive, options) {
  const contentTypes = parseContentTypes(archive);
  const workbookSheets = parseWorkbookSheets(archive);
  const theme = parseWorkbookTheme(archive);
  const themePalette = buildThemePalette(theme);
  const { defaultFont, namedCellStyleByName, styleById, tableStyleByName } = parseWorkbookStyles(archive);
  const tableMetadataByWorkbookSheetIndex = parseWorkbookTableMetadata(archive, workbookSheets);
  return {
    contentTypes,
    namedCellStyleByName,
    sheetStatesByWorkbookSheetIndex: workbookSheets.map((sheet) => parseSheetState(archive, sheet.path, {
      ...options,
      defaultFont,
      themePalette
    })),
    styleById,
    tableMetadataByWorkbookSheetIndex,
    tableStyleByName,
    theme,
    themePalette,
    workbookSheets
  };
}
function parseWorkbookStructureAssets(bytes, options) {
  const archive = unzipSync(bytes);
  const {
    namedCellStyleByName,
    sheetStatesByWorkbookSheetIndex,
    styleById,
    tableMetadataByWorkbookSheetIndex,
    tableStyleByName,
    themePalette
  } = parseWorkbookStructureAssetsFromArchive(archive, options);
  return {
    namedCellStyleByName,
    sheetStatesByWorkbookSheetIndex,
    styleById,
    tableMetadataByWorkbookSheetIndex,
    tableStyleByName,
    themePalette
  };
}
function parseWorkbookChartStyleAssets(bytes) {
  const archive = unzipSync(bytes);
  const {
    themePalette,
    workbookSheets
  } = parseWorkbookStructureAssetsFromArchive(archive);
  const sheetOrigins = [];
  workbookSheets.forEach((sheet, workbookSheetIndex) => {
    const sheetRelationships = parseRelationships(archive, relsPathForDocument(sheet.path), sheet.path);
    const attachments = [];
    for (const relationship of sheetRelationships.values()) {
      if (relationship.type !== DRAWING_REL_TYPE) {
        continue;
      }
      const drawingPath = relationship.target;
      const drawingRelsPath = relsPathForDocument(drawingPath);
      attachments.push({
        drawingPath,
        drawingRelsPath: archive[drawingRelsPath] ? drawingRelsPath : null,
        mediaPaths: []
      });
    }
    sheetOrigins[workbookSheetIndex] = attachments.length > 0 ? {
      attachments,
      workbookSheetIndex
    } : null;
  });
  return {
    archive,
    sheetOrigins,
    themePalette
  };
}
function resolveSheetColumnWidthPixels(width, columnWidthCharacterWidthPx) {
  return sheetColumnWidthToPixels(width, columnWidthCharacterWidthPx);
}

// src/safe-calculate.ts
var SHEET_REF_REGEX = /'((?:[^']|'')+)'!|([A-Za-z_\u0080-\uFFFF][\w.\u0080-\uFFFF]*)!/g;
function collectReferencedSheetNames(workbook2) {
  const referenced = /* @__PURE__ */ new Set();
  for (let sheetIdx = 0; sheetIdx < workbook2.sheetCount; sheetIdx += 1) {
    let sheet;
    try {
      sheet = workbook2.getSheet(sheetIdx);
    } catch {
      continue;
    }
    const cells = sheet.formulaCells;
    if (!Array.isArray(cells)) {
      continue;
    }
    for (const cell of cells) {
      const formula = cell?.formula;
      if (!formula) {
        continue;
      }
      SHEET_REF_REGEX.lastIndex = 0;
      let match;
      while ((match = SHEET_REF_REGEX.exec(formula)) !== null) {
        const raw = match[1] ?? match[2];
        if (!raw) {
          continue;
        }
        referenced.add(raw.replace(/''/g, "'"));
      }
    }
  }
  return referenced;
}
function hasUnresolvedSheetReferences(workbook2) {
  let names;
  try {
    names = workbook2.sheetNames;
  } catch {
    return false;
  }
  const known = new Set(names);
  const referenced = collectReferencedSheetNames(workbook2);
  for (const name of referenced) {
    if (!known.has(name)) {
      return true;
    }
  }
  return false;
}
function safeCalculate(workbook2, options = {}) {
  if (hasUnresolvedSheetReferences(workbook2)) {
    return { workbook: workbook2, calculated: false, skipReason: "unresolved-sheet-refs" };
  }
  try {
    workbook2.calculate();
    return { workbook: workbook2, calculated: true, skipReason: null };
  } catch (err) {
    console.warn("[react-xlsx] workbook.calculate() trapped; falling back to cached formula values", err);
    if (options.reparse) {
      try {
        return { workbook: options.reparse(), calculated: false, skipReason: "calculate-trapped" };
      } catch (reparseErr) {
        console.warn("[react-xlsx] workbook reparse after calculate trap failed", reparseErr);
      }
    }
    return { workbook: workbook2, calculated: false, skipReason: "calculate-trapped" };
  }
}

// src/wasm.ts
var wasmModulePromise = null;
var hasConfiguredWasmSource = false;
var configuredWasmSource;
var configuredWorkerWasmSource;
function bufferSourceToArrayBuffer(source) {
  if (source instanceof ArrayBuffer) {
    return source.slice(0);
  }
  const bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  const copy = new Uint8Array(bytes);
  return copy.buffer;
}
function sourceToWorkerSource(source) {
  if (typeof source === "string") {
    return source;
  }
  if (typeof URL !== "undefined" && source instanceof URL) {
    return source.href;
  }
  if (typeof Request !== "undefined" && source instanceof Request) {
    return source.url;
  }
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    return bufferSourceToArrayBuffer(source);
  }
  if (typeof WebAssembly !== "undefined" && source instanceof WebAssembly.Module) {
    return source;
  }
  return void 0;
}
function setWasmSource(source) {
  hasConfiguredWasmSource = true;
  configuredWasmSource = source;
  configuredWorkerWasmSource = sourceToWorkerSource(source);
}
function getSheetsWasmModule() {
  if (!wasmModulePromise) {
    wasmModulePromise = import("@dukelib/sheets-wasm").then(async (mod) => {
      if (configuredWasmSource !== void 0) {
        await mod.default({ module_or_path: configuredWasmSource });
      } else {
        await mod.default();
      }
      return mod;
    });
  }
  return wasmModulePromise;
}

// src/xlsx-worker.ts
var DEFAULT_ROW_HEIGHT = 24;
var DEFAULT_COL_WIDTH = 80;
var DEFAULT_ZOOM_SCALE = 100;
var FORMULA_COUNT_THRESHOLD = 1e3;
var FAST_STRUCTURE_PARSE_THRESHOLD_BYTES = 5 * 1024 * 1024;
function isLegacyXlsWorkbook(bytes) {
  return bytes.byteLength >= 8 && bytes[0] === 208 && bytes[1] === 207 && bytes[2] === 17 && bytes[3] === 224 && bytes[4] === 161 && bytes[5] === 177 && bytes[6] === 26 && bytes[7] === 225;
}
function shouldSkipXmlParsingForWorkbook(bytes, skipXmlParsing = false) {
  return skipXmlParsing || isLegacyXlsWorkbook(bytes);
}
function normalizeWorksheetVisibility2(value) {
  return value === "hidden" || value === "veryHidden" ? value : "visible";
}
var workbook = null;
var chartsByWorkbookSheetIndex = [];
var chartsheets = [];
var sheets = [];
var tablesByWorkbookSheetIndex = [];
var tabs = [];
function buildVisibleSheetIndexByWorkbookSheetIndex(nextWorkbook, showHiddenSheets = false) {
  const mapping = /* @__PURE__ */ new Map();
  let visibleIndex = 0;
  for (let workbookSheetIndex = 0; workbookSheetIndex < nextWorkbook.sheetCount; workbookSheetIndex += 1) {
    const worksheet = nextWorkbook.getSheet(workbookSheetIndex);
    const visibility = normalizeWorksheetVisibility2(worksheet.visibility);
    if (!showHiddenSheets && visibility !== "visible") {
      continue;
    }
    mapping.set(workbookSheetIndex, visibleIndex);
    visibleIndex += 1;
  }
  return mapping;
}
function normalizeRange(range) {
  return {
    start: {
      col: Math.min(range.start.col, range.end.col),
      row: Math.min(range.start.row, range.end.row)
    },
    end: {
      col: Math.max(range.start.col, range.end.col),
      row: Math.max(range.start.row, range.end.row)
    }
  };
}
function parseA1CellReference2(reference) {
  const match = /^([A-Z]+)(\d+)$/i.exec(reference.trim());
  if (!match) {
    return null;
  }
  const [, columnPart, rowPart] = match;
  let col = 0;
  for (const char of columnPart.toUpperCase()) {
    col = col * 26 + (char.charCodeAt(0) - 64);
  }
  return {
    col: col - 1,
    row: Number(rowPart) - 1
  };
}
function parseA1RangeReference2(reference) {
  const [startRef, endRef = startRef] = reference.split(":");
  const start = parseA1CellReference2(startRef ?? "");
  const end = parseA1CellReference2(endRef ?? "");
  if (!start || !end) {
    return null;
  }
  return normalizeRange({ end, start });
}
function parseWorksheetFreezePanes(worksheet) {
  const rawFreezePanes = worksheet.freezePanes;
  const row = typeof rawFreezePanes?.row === "number" && rawFreezePanes.row >= 0 ? rawFreezePanes.row : null;
  const col = typeof rawFreezePanes?.col === "number" && rawFreezePanes.col >= 0 ? rawFreezePanes.col : null;
  if (row === null && col === null) {
    return null;
  }
  return {
    col: col ?? 0,
    row: row ?? 0
  };
}
function parseWorksheetDataValidations(worksheet) {
  const rawDataValidations = Array.isArray(worksheet.dataValidations) ? worksheet.dataValidations : [];
  return rawDataValidations.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const validation = entry;
    const ranges = Array.isArray(validation.ranges) ? validation.ranges.flatMap((range) => {
      if (typeof range !== "string") {
        return [];
      }
      const parsedRange = parseA1RangeReference2(range);
      return parsedRange ? [parsedRange] : [];
    }) : [];
    const validationType = typeof validation.validationType === "string" ? validation.validationType : null;
    if (!validationType || ranges.length === 0) {
      return [];
    }
    return [{
      allowBlank: typeof validation.allowBlank === "boolean" ? validation.allowBlank : void 0,
      errorMessage: typeof validation.errorMessage === "string" ? validation.errorMessage : void 0,
      errorStyle: typeof validation.errorStyle === "string" ? validation.errorStyle : void 0,
      inputMessage: typeof validation.inputMessage === "string" ? validation.inputMessage : void 0,
      listSource: typeof validation.listSource === "string" ? validation.listSource : void 0,
      ranges,
      showDropdown: typeof validation.showDropdown === "boolean" ? validation.showDropdown : void 0,
      showErrorAlert: typeof validation.showErrorAlert === "boolean" ? validation.showErrorAlert : void 0,
      showInputMessage: typeof validation.showInputMessage === "boolean" ? validation.showInputMessage : void 0,
      validationType
    }];
  });
}
function resolveWorksheetZoomScale(worksheet, sheetState) {
  const candidates = [
    sheetState?.zoomScale,
    typeof worksheet.zoomScale === "number" ? worksheet.zoomScale : void 0
  ];
  const value = candidates.find((entry) => typeof entry === "number" && Number.isFinite(entry) && entry > 0);
  return value ?? DEFAULT_ZOOM_SCALE;
}
function resolveSheetDisplayUsedRange(usedRange, sheetState) {
  const [minRow, minCol, maxRow, maxCol] = usedRange;
  const maxMeaningfulRow = Math.max(sheetState?.maxContentRow ?? -1, sheetState?.maxVerticalMergeEndRow ?? -1);
  const maxMeaningfulCol = Math.max(sheetState?.maxContentCol ?? -1, sheetState?.maxHorizontalMergeEndCol ?? -1);
  if (maxMeaningfulRow < 0 && maxMeaningfulCol < 0) {
    return usedRange;
  }
  return [
    sheetState?.minContentRow !== void 0 && sheetState.minContentRow >= 0 ? Math.min(minRow, sheetState.minContentRow) : minRow,
    sheetState?.minContentCol !== void 0 && sheetState.minContentCol >= 0 ? Math.min(minCol, sheetState.minContentCol) : minCol,
    maxMeaningfulRow >= 0 ? Math.min(maxRow, maxMeaningfulRow) : maxRow,
    maxMeaningfulCol >= 0 ? Math.min(maxCol, maxMeaningfulCol) : maxCol
  ];
}
function buildSheetList(nextWorkbook, structureAssets, showHiddenSheets = false) {
  const sheetsByWorkbookSheetIndex = [];
  for (let index = 0; index < nextWorkbook.sheetCount; index += 1) {
    const worksheet = nextWorkbook.getSheet(index);
    const sheetState = structureAssets?.sheetStatesByWorkbookSheetIndex[index] ?? null;
    const visibility = normalizeWorksheetVisibility2(worksheet.visibility);
    if (!showHiddenSheets && visibility !== "visible") {
      continue;
    }
    const resolveColumnWidthPx = (col) => {
      const width = worksheet.getColumnWidth(col);
      if (width !== void 0 && width !== null) {
        return resolveSheetColumnWidthPixels(width, sheetState?.columnWidthCharacterWidthPx);
      }
      return sheetState?.colWidthOverridesPx?.[col] ?? sheetState?.defaultColWidthPx ?? DEFAULT_COL_WIDTH;
    };
    const resolveRowHeightPx = (row) => {
      const height = worksheet.getRowHeight(row);
      if (height !== void 0 && height !== null) {
        return Math.max(Math.round(height * 1.33), 16);
      }
      return sheetState?.rowHeightOverridesPx?.[row] ?? sheetState?.defaultRowHeightPx ?? DEFAULT_ROW_HEIGHT;
    };
    const usedRange = worksheet.usedRange();
    if (!usedRange) {
      sheetsByWorkbookSheetIndex.push({
        cachedFormulaValues: sheetState?.cachedFormulaValues ?? {},
        columnWidthCharacterWidthPx: sheetState?.columnWidthCharacterWidthPx,
        colCount: 0,
        colStyleIds: sheetState?.colStyleIds ?? {},
        colWidthOverridesPx: sheetState?.colWidthOverridesPx ?? {},
        colWidths: [],
        conditionalFormatRules: sheetState?.conditionalFormatRules ?? [],
        dataValidations: parseWorksheetDataValidations(worksheet),
        defaultColWidthPx: sheetState?.defaultColWidthPx ?? DEFAULT_COL_WIDTH,
        defaultRowHeightPx: sheetState?.defaultRowHeightPx ?? DEFAULT_ROW_HEIGHT,
        freezePanes: parseWorksheetFreezePanes(worksheet),
        hasHorizontalMerges: sheetState?.hasHorizontalMerges ?? false,
        hasVerticalMerges: sheetState?.hasVerticalMerges ?? false,
        maxHorizontalMergeEndCol: sheetState?.maxHorizontalMergeEndCol ?? -1,
        maxVerticalMergeEndRow: sheetState?.maxVerticalMergeEndRow ?? -1,
        hiddenCols: sheetState?.hiddenCols ?? [],
        hiddenRows: sheetState?.hiddenRows ?? [],
        minUsedCol: -1,
        minUsedRow: -1,
        maxUsedCol: -1,
        maxUsedRow: -1,
        name: worksheet.name,
        visibility,
        namedCellStyleByName: structureAssets?.namedCellStyleByName ?? {},
        rowCount: 0,
        rowHeightOverridesPx: sheetState?.rowHeightOverridesPx ?? {},
        rowHeights: [],
        rowStyleIds: sheetState?.rowStyleIds ?? {},
        showGridLines: sheetState?.showGridLines ?? true,
        sparklines: sheetState?.sparklines ?? [],
        styleById: structureAssets?.styleById ?? {},
        tableStyleByName: structureAssets?.tableStyleByName ?? {},
        themePalette: structureAssets?.themePalette ?? { colorsByIndex: {} },
        visibleCols: [],
        visibleRows: [],
        workbookSheetIndex: index,
        zoomScale: resolveWorksheetZoomScale(worksheet, sheetState)
      });
      continue;
    }
    const [minRow, minCol, maxRow, maxCol] = resolveSheetDisplayUsedRange(usedRange, sheetState);
    const hiddenRows = (sheetState?.hiddenRows ?? []).filter((row) => row >= 0 && row <= maxRow);
    const hiddenCols = (sheetState?.hiddenCols ?? []).filter((col) => col >= 0 && col <= maxCol);
    sheetsByWorkbookSheetIndex.push({
      cachedFormulaValues: sheetState?.cachedFormulaValues ?? {},
      columnWidthCharacterWidthPx: sheetState?.columnWidthCharacterWidthPx,
      colCount: Math.max(0, maxCol + 1 - hiddenCols.length),
      colStyleIds: sheetState?.colStyleIds ?? {},
      colWidthOverridesPx: sheetState?.colWidthOverridesPx ?? {},
      colWidths: [],
      conditionalFormatRules: sheetState?.conditionalFormatRules ?? [],
      dataValidations: parseWorksheetDataValidations(worksheet),
      defaultColWidthPx: sheetState?.defaultColWidthPx ?? DEFAULT_COL_WIDTH,
      defaultRowHeightPx: sheetState?.defaultRowHeightPx ?? DEFAULT_ROW_HEIGHT,
      freezePanes: parseWorksheetFreezePanes(worksheet),
      hasHorizontalMerges: sheetState?.hasHorizontalMerges ?? false,
      hasVerticalMerges: sheetState?.hasVerticalMerges ?? false,
      maxHorizontalMergeEndCol: sheetState?.maxHorizontalMergeEndCol ?? -1,
      maxVerticalMergeEndRow: sheetState?.maxVerticalMergeEndRow ?? -1,
      hiddenCols,
      hiddenRows,
      minUsedCol: minCol,
      minUsedRow: minRow,
      maxUsedCol: maxCol,
      maxUsedRow: maxRow,
      name: worksheet.name,
      visibility,
      namedCellStyleByName: structureAssets?.namedCellStyleByName ?? {},
      rowCount: Math.max(0, maxRow + 1 - hiddenRows.length),
      rowHeightOverridesPx: sheetState?.rowHeightOverridesPx ?? {},
      rowHeights: [],
      rowStyleIds: sheetState?.rowStyleIds ?? {},
      showGridLines: sheetState?.showGridLines ?? true,
      sparklines: sheetState?.sparklines ?? [],
      styleById: structureAssets?.styleById ?? {},
      tableStyleByName: structureAssets?.tableStyleByName ?? {},
      themePalette: structureAssets?.themePalette ?? { colorsByIndex: {} },
      visibleCols: [],
      visibleRows: [],
      workbookSheetIndex: index,
      zoomScale: resolveWorksheetZoomScale(worksheet, sheetState)
    });
  }
  return sheetsByWorkbookSheetIndex;
}
function mapWorksheetTables(worksheet, metadataForSheet) {
  const rawTables = worksheet?.tables ?? [];
  return rawTables.flatMap((table, index) => {
    const rawColumns = Array.isArray(table.columns) ? table.columns : [];
    const rawName = typeof table.name === "string" ? table.name : `Table${index + 1}`;
    const rawDisplayName = typeof table.displayName === "string" ? table.displayName : typeof table.name === "string" ? table.name : `Table ${index + 1}`;
    const metadata = metadataForSheet?.find(
      (entry) => entry.name && entry.name === rawName || entry.displayName && entry.displayName === rawDisplayName || entry.reference && entry.reference === table.reference
    );
    const rawReference = typeof table.reference === "string" ? table.reference : "";
    const reference = metadata?.reference ?? rawReference;
    const parsedRange = parseA1RangeReference2(reference);
    if (!parsedRange) {
      return [];
    }
    return [{
      columns: rawColumns.map((column, columnIndex) => ({
        id: typeof column.id === "number" ? column.id ?? columnIndex + 1 : columnIndex + 1,
        index: columnIndex,
        name: typeof column.name === "string" ? column.name ?? `Column ${columnIndex + 1}` : `Column ${columnIndex + 1}`
      })),
      displayName: rawDisplayName,
      end: parsedRange.end,
      headerRowCount: metadata?.headerRowCount ?? resolveWorkbookTableCount(table.headerRowCount, 1),
      headerRowCellStyle: metadata?.headerRowCellStyle,
      name: rawName,
      reference,
      start: parsedRange.start,
      styleInfo: table.styleInfo,
      totalsRowCount: metadata?.totalsRowCount ?? resolveWorkbookTableCount(table.totalsRowCount, 0),
      totalsRowShown: metadata?.totalsRowShown ?? resolveWorkbookTableBoolean(table.totalsRowShown)
    }];
  });
}
function resolveWorkbookTableCount(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return fallback;
}
function resolveWorkbookTableBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "0" || normalized === "false" || normalized === "") {
      return false;
    }
    if (normalized === "1" || normalized === "true") {
      return true;
    }
  }
  return false;
}
function decodeHtmlEntities(value) {
  return value.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function getCellDisplayValue(worksheet, row, col, activeSheet) {
  const formula = worksheet.getFormulaAt(row, col);
  const cachedFormulaValue = formula ? activeSheet?.cachedFormulaValues?.[cellAddressToA1({ row, col })] : void 0;
  const formatted = worksheet.getFormattedValueAt(row, col);
  if (formatted && !(formula && cachedFormulaValue !== void 0 && formatted.startsWith("#"))) {
    return decodeHtmlEntities(formatted);
  }
  const cellValue = worksheet.getCalculatedValueAt(row, col);
  if (formula && cachedFormulaValue !== void 0 && cellValue.is_error) {
    return cachedFormulaValue;
  }
  if (cellValue.is_error) {
    return cellValue.asError() ?? "";
  }
  if (cellValue.is_empty) {
    return "";
  }
  return cellValue.toString();
}
function cellAddressToA1(cell) {
  let col = cell.col + 1;
  let label = "";
  while (col > 0) {
    const remainder = (col - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    col = Math.floor((col - 1) / 26);
  }
  return `${label}${cell.row + 1}`;
}
async function loadWorkbook(buffer, skipXmlParsing = false, showHiddenSheets = false) {
  const wasmModule = await getSheetsWasmModule();
  const bytes = new Uint8Array(buffer);
  const effectiveSkipXmlParsing = shouldSkipXmlParsingForWorkbook(bytes, skipXmlParsing);
  let activeWorkbook = wasmModule.Workbook.fromBytes(bytes);
  let totalFormulas = 0;
  for (let index = 0; index < activeWorkbook.sheetCount; index += 1) {
    totalFormulas += activeWorkbook.getSheet(index).formulaCount;
  }
  if (totalFormulas <= FORMULA_COUNT_THRESHOLD) {
    const result = safeCalculate(activeWorkbook, {
      reparse: () => wasmModule.Workbook.fromBytes(bytes)
    });
    activeWorkbook = result.workbook;
  }
  const nextWorkbook = activeWorkbook;
  const shouldUseFastStructureParse = bytes.byteLength >= FAST_STRUCTURE_PARSE_THRESHOLD_BYTES && totalFormulas <= FORMULA_COUNT_THRESHOLD;
  const structureAssets = effectiveSkipXmlParsing || shouldUseFastStructureParse ? null : parseWorkbookStructureAssets(bytes, {
    includeCachedFormulaValues: true
  });
  workbook = nextWorkbook;
  sheets = buildSheetList(nextWorkbook, structureAssets, showHiddenSheets);
  tablesByWorkbookSheetIndex = Array.from(
    { length: nextWorkbook.sheetCount },
    (_, workbookSheetIndex) => mapWorksheetTables(
      nextWorkbook.getSheet(workbookSheetIndex),
      structureAssets?.tableMetadataByWorkbookSheetIndex[workbookSheetIndex] ?? null
    )
  );
  const visibleSheetIndexByWorkbookSheetIndex = new Map(sheets.map((sheet, index) => [sheet.workbookSheetIndex, index]));
  const hasCharts = Array.from({ length: nextWorkbook.sheetCount }, (_, workbookSheetIndex) => {
    const worksheet = nextWorkbook.getSheet(workbookSheetIndex);
    const hasClassicCharts = Array.isArray(worksheet.charts) && worksheet.charts.length > 0;
    const hasModernCharts = Array.isArray(worksheet.chartsEx) && worksheet.chartsEx.length > 0;
    return hasClassicCharts || hasModernCharts;
  }).some(Boolean);
  const chartStyleAssets = effectiveSkipXmlParsing || !hasCharts ? null : parseWorkbookChartStyleAssets(bytes);
  const chartAssets = loadWorkbookChartAssets(
    nextWorkbook,
    chartStyleAssets,
    visibleSheetIndexByWorkbookSheetIndex,
    showHiddenSheets
  );
  chartsByWorkbookSheetIndex = chartAssets.chartsByWorkbookSheetIndex;
  chartsheets = chartAssets.chartsheets;
  tabs = chartAssets.tabs;
  return {
    chartsByWorkbookSheetIndex,
    chartsheets,
    sheets,
    tablesByWorkbookSheetIndex,
    tabs
  };
}
async function parseCharts(buffer, skipXmlParsing = false, showHiddenSheets = false) {
  const wasmModule = await getSheetsWasmModule();
  const bytes = new Uint8Array(buffer);
  const effectiveSkipXmlParsing = shouldSkipXmlParsingForWorkbook(bytes, skipXmlParsing);
  let activeWorkbook = wasmModule.Workbook.fromBytes(bytes);
  let totalFormulas = 0;
  for (let index = 0; index < activeWorkbook.sheetCount; index += 1) {
    totalFormulas += activeWorkbook.getSheet(index).formulaCount;
  }
  if (totalFormulas <= FORMULA_COUNT_THRESHOLD) {
    const result = safeCalculate(activeWorkbook, {
      reparse: () => wasmModule.Workbook.fromBytes(bytes)
    });
    activeWorkbook = result.workbook;
  }
  const nextWorkbook = activeWorkbook;
  const visibleSheetIndexByWorkbookSheetIndex = buildVisibleSheetIndexByWorkbookSheetIndex(nextWorkbook, showHiddenSheets);
  const chartStyleAssets = effectiveSkipXmlParsing ? null : parseWorkbookChartStyleAssets(bytes);
  const chartAssets = loadWorkbookChartAssets(
    nextWorkbook,
    chartStyleAssets,
    visibleSheetIndexByWorkbookSheetIndex,
    showHiddenSheets
  );
  return {
    chartsByWorkbookSheetIndex: chartAssets.chartsByWorkbookSheetIndex,
    chartsheets: chartAssets.chartsheets,
    tabs: chartAssets.tabs
  };
}
function respond(message) {
  self.postMessage(message);
}
async function handleMessage(message) {
  switch (message.type) {
    case "load": {
      if (message.payload.wasmSource !== void 0) {
        setWasmSource(message.payload.wasmSource);
      }
      return loadWorkbook(message.payload.buffer, message.payload.skipXmlParsing, message.payload.showHiddenSheets);
    }
    case "parseCharts": {
      if (message.payload.wasmSource !== void 0) {
        setWasmSource(message.payload.wasmSource);
      }
      return parseCharts(message.payload.buffer, message.payload.skipXmlParsing, message.payload.showHiddenSheets);
    }
    case "getCellSnapshot": {
      if (!workbook) {
        return {
          displayValue: "",
          formula: ""
        };
      }
      const targetSheet = sheets.find((sheet) => sheet.workbookSheetIndex === message.payload.workbookSheetIndex) ?? null;
      const worksheet = workbook.getSheet(message.payload.workbookSheetIndex);
      return {
        displayValue: getCellDisplayValue(worksheet, message.payload.row, message.payload.col, targetSheet),
        formula: worksheet.getFormulaAt(message.payload.row, message.payload.col) ?? ""
      };
    }
    case "getRowsBatch": {
      if (!workbook) {
        return null;
      }
      const worksheet = workbook.getSheet(message.payload.workbookSheetIndex);
      if (typeof worksheet.getRowsBatch !== "function") {
        return null;
      }
      return worksheet.getRowsBatch(message.payload.startRow, message.payload.rowCount, {
        includeFormulas: true,
        includeHyperlinks: true,
        includeMergeInfo: true,
        includeStyles: true,
        useFormattedValues: true
      });
    }
    default:
      return null;
  }
}
self.addEventListener("message", (event) => {
  const message = event.data;
  void handleMessage(message).then((result) => {
    respond({
      id: message.id,
      result,
      success: true
    });
  }).catch((error) => {
    respond({
      error: error instanceof Error ? error.message : "Worker request failed.",
      id: message.id,
      success: false
    });
  });
});
//# sourceMappingURL=xlsx-worker.js.map