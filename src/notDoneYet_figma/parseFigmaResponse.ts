import {
  Component,
  ComponentSet,
  GetFileNodesResponse,
  GetFileResponse,
  Node as FigmaDocumentNode,
} from '@figma/rest-api-spec';
import {
  SimplifiedDesign,
  SimplifiedFill,
  SimplifiedNode,
} from './simplfiedDesign';
import {
  isVisible,
  parsePaint,
  removeEmptyKeys,
  StyleId,
} from './utils/common';
import {
  sanitizeComponents,
  sanitizeComponentSets,
} from './utils/sanitization';
import {
  buildSimplifiedEffects,
  SimplifiedEffects,
} from './transformers/effects';
import { buildSimplifiedLayout, SimplifiedLayout } from './transformers/layout';
import { buildSimplifiedStrokes, SimplifiedStroke } from './transformers/style';
import { hasValue, isTruthy, isRectangleCornerRadii } from './utils/identity';
export type TextStyle = Partial<{
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  lineHeight: string;
  letterSpacing: string;
  textCase: string;
  textAlignHorizontal: string;
  textAlignVertical: string;
}>;
export type StrokeWeights = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};
type StyleTypes =
  | TextStyle
  | SimplifiedFill[]
  | SimplifiedLayout
  | SimplifiedStroke
  | SimplifiedEffects
  | string;

type GlobalVars = {
  styles: Record<StyleId, StyleTypes>;
};

export function parseFigmaResponse(
  data: GetFileResponse | GetFileNodesResponse
): SimplifiedDesign {
  const aggregatedComponents: Record<string, Component> = {};
  const aggregatedComponentSets: Record<string, ComponentSet> = {};
  let nodesToParse: Array<FigmaDocumentNode>;

  if ('nodes' in data) {
    // GetFileNodesResponse
    const nodeResponses = Object.values(data.nodes); // Compute once
    nodeResponses.forEach((nodeResponse) => {
      if (nodeResponse.components) {
        Object.assign(aggregatedComponents, nodeResponse.components);
      }
      if (nodeResponse.componentSets) {
        Object.assign(aggregatedComponentSets, nodeResponse.componentSets);
      }
    });
    nodesToParse = nodeResponses.map((n) => n.document);
  } else {
    // GetFileResponse
    Object.assign(aggregatedComponents, data.components);
    Object.assign(aggregatedComponentSets, data.componentSets);
    nodesToParse = data.document.children;
  }

  const sanitizedComponents = sanitizeComponents(aggregatedComponents);
  const sanitizedComponentSets = sanitizeComponentSets(aggregatedComponentSets);

  const { name, lastModified, thumbnailUrl } = data;

  let globalVars: GlobalVars = {
    styles: {},
  };

  const simplifiedNodes: SimplifiedNode[] = nodesToParse
    .filter(isVisible)
    .map((n) => parseNode(globalVars, n))
    .filter((child) => child !== null && child !== undefined);

  const simplifiedDesign: SimplifiedDesign = {
    name,
    lastModified,
    thumbnailUrl: thumbnailUrl || '',
    nodes: simplifiedNodes,
    components: sanitizedComponents,
    componentSets: sanitizedComponentSets,
    globalVars,
  };

  return removeEmptyKeys(simplifiedDesign);
}

function parseNode(
  globalVars: GlobalVars,
  n: FigmaDocumentNode,
  parent?: FigmaDocumentNode
): SimplifiedNode | null {
  const { id, name, type } = n;

  const simplified: SimplifiedNode = {
    id,
    name,
    type,
  };

  if (type === 'INSTANCE') {
    if (hasValue('componentId', n)) {
      simplified.componentId = n.componentId;
    }

    // Add specific properties for instances of components
    if (hasValue('componentProperties', n)) {
      simplified.componentProperties = Object.entries(
        n.componentProperties ?? {}
      ).map(([name, { value, type }]) => ({
        name,
        value: value.toString(),
        type,
      }));
    }
  }

  // text
  if (hasValue('style', n) && Object.keys(n.style).length) {
    const style = n.style;
    const textStyle: TextStyle = {
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      fontSize: style.fontSize,
      lineHeight:
        style.lineHeightPx && style.fontSize
          ? `${style.lineHeightPx / style.fontSize}em`
          : undefined,
      letterSpacing:
        style.letterSpacing && style.letterSpacing !== 0 && style.fontSize
          ? `${(style.letterSpacing / style.fontSize) * 100}%`
          : undefined,
      textCase: style.textCase,
      textAlignHorizontal: style.textAlignHorizontal,
      textAlignVertical: style.textAlignVertical,
    };
    simplified.textStyle = findOrCreateVar(globalVars, textStyle, 'style');
  }

  // fills & strokes
  if (hasValue('fills', n) && Array.isArray(n.fills) && n.fills.length) {
    // const fills = simplifyFills(n.fills.map(parsePaint));
    const fills = n.fills.map(parsePaint);
    simplified.fills = findOrCreateVar(globalVars, fills, 'fill');
  }

  const strokes = buildSimplifiedStrokes(n);
  if (strokes.colors.length) {
    simplified.strokes = findOrCreateVar(globalVars, strokes, 'stroke');
  }

  const effects = buildSimplifiedEffects(n);
  if (Object.keys(effects).length) {
    simplified.effects = findOrCreateVar(globalVars, effects, 'effect');
  }

  // Process layout
  const layout = buildSimplifiedLayout(n, parent);
  if (Object.keys(layout).length > 1) {
    simplified.layout = findOrCreateVar(globalVars, layout, 'layout');
  }

  // Keep other simple properties directly
  if (hasValue('characters', n, isTruthy)) {
    simplified.text = n.characters;
  }

  // border/corner

  // opacity
  if (
    hasValue('opacity', n) &&
    typeof n.opacity === 'number' &&
    n.opacity !== 1
  ) {
    simplified.opacity = n.opacity;
  }

  if (hasValue('cornerRadius', n) && typeof n.cornerRadius === 'number') {
    simplified.borderRadius = `${n.cornerRadius}px`;
  }
  if (hasValue('rectangleCornerRadii', n, isRectangleCornerRadii)) {
    simplified.borderRadius = `${n.rectangleCornerRadii[0]}px ${n.rectangleCornerRadii[1]}px ${n.rectangleCornerRadii[2]}px ${n.rectangleCornerRadii[3]}px`;
  }

  // Recursively process child nodes.
  // Include children at the very end so all relevant configuration data for the element is output first and kept together for the AI.
  if (hasValue('children', n) && n.children.length > 0) {
    const children = n.children
      .filter(isVisible)
      .map((child) => parseNode(globalVars, child, n))
      .filter((child) => child !== null && child !== undefined);
    if (children.length) {
      simplified.children = children;
    }
  }

  // Convert VECTOR to IMAGE
  if (type === 'VECTOR') {
    simplified.type = 'IMAGE-SVG';
  }

  return simplified;
}
function findOrCreateVar(
  globalVars: GlobalVars,
  textStyle: Partial<{
    fontFamily: string;
    fontWeight: number;
    fontSize: number;
    lineHeight: string;
    letterSpacing: string;
    textCase: string;
    textAlignHorizontal: string;
    textAlignVertical: string;
  }>,
  arg2: string
): string | undefined {
  throw new Error('Function not implemented.');
}
