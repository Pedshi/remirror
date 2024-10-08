import {
  Coords,
  EditorState,
  findParentNode,
  FindProsemirrorNodeResult,
  getDefaultBlockNode,
  GetMarkRange,
  getMarkRanges,
  getSelectedWord,
  getTextSelection,
  isAllSelection,
  isElementDomNode,
  isSelectionEmpty,
  isTextSelection,
  MarkType,
  Shape,
} from '@remirror/core';

import { Positioner, PositionerPosition } from './positioner';
import { hasStateChanged, isEmptyBlockNode, isPositionVisible } from './positioner-utils';

const basePosition = { y: -999_999, x: -999_999, width: 0, height: 0 };
const baseRect = {
  ...basePosition,
  left: -999_999,
  top: -999_999,
  bottom: -999_999,
  right: -999_999,
};
export const defaultAbsolutePosition: PositionerPosition = {
  ...basePosition,
  rect: { ...baseRect, toJSON: () => baseRect as Shape },
  visible: false,
};

/**
 * Creates a positioner for the current block node.
 *
 * It spans the full width and height of the block.
 */
export const blockNodePositioner = Positioner.create<FindProsemirrorNodeResult>({
  hasChanged: hasStateChanged,

  /**
   * This is only active for empty top level nodes. The data is the cursor start
   * and end position.
   */
  getActive(props) {
    const { state } = props;

    if (!isSelectionEmpty(state) || state.selection.$anchor.depth > 2) {
      return Positioner.EMPTY;
    }

    const parentNode = findParentNode({ predicate: (node) => node.type.isBlock, selection: state });

    return parentNode ? [parentNode] : Positioner.EMPTY;
  },

  getPosition(props) {
    const { view, data } = props;
    const node = view.nodeDOM(data.pos);

    if (!isElementDomNode(node)) {
      // This should never happen.
      return defaultAbsolutePosition;
    }

    const rect = node.getBoundingClientRect();
    const editorRect = view.dom.getBoundingClientRect();

    // The width and height of the current selected block node.
    const height = rect.height;
    const width = rect.width;

    // The top and left relative to the parent `editorRect`.
    const left = view.dom.scrollLeft + rect.left - editorRect.left;
    const top = view.dom.scrollTop + rect.top - editorRect.top;
    const visible = isPositionVisible(rect, view.dom);

    return { y: top, x: left, height, width, rect, visible };
  },
});

/**
 * Creates a positioner for the visible portion editor.
 *
 * E.g. The "viewport" of the editor inside any scrollable area.
 */
export const editorPositioner = Positioner.create<boolean>({
  hasChanged: hasStateChanged,

  /**
   * This is always active, regardless of selection position
   */
  getActive() {
    return [true];
  },

  getPosition(props) {
    const { view } = props;

    const rect = view.dom.getBoundingClientRect();

    // The width and height of the visible portion of the editor.
    const height = Math.min(view.dom.clientHeight, rect.height);
    const width = Math.min(view.dom.clientWidth, rect.width);

    // The top and left values are the internal scroll positions of the editor.
    const left = view.dom.scrollLeft;
    const top = view.dom.scrollTop;
    const visible = true;

    return { y: top, x: left, height, width, rect, visible };
  },
});

/**
 * Returns the block node position only when it is empty and the selection is
 * empty.
 */
export const emptyBlockNodePositioner = blockNodePositioner.clone(({ getActive }) => ({
  getActive: (props) => {
    const [parentNode] = getActive(props);
    return parentNode &&
      isEmptyBlockNode(parentNode.node) &&
      parentNode.node.type === getDefaultBlockNode(props.state.schema)
      ? [parentNode]
      : Positioner.EMPTY;
  },
}));

/**
 * Returns the position as a single pixel width for the start of the block node
 * as a position
 */
export const emptyBlockNodeStartPositioner = emptyBlockNodePositioner.clone(({ getPosition }) => ({
  getPosition: (props) => ({ ...getPosition(props), width: 1 }),
}));

/**
 * Returns the position as a single pixel width for the end of the current block
 * node.
 */
export const emptyBlockNodeEndPositioner = emptyBlockNodePositioner.clone(({ getPosition }) => ({
  getPosition: (props) => {
    const { width, x: left, y: top, height } = getPosition(props);
    return {
      ...getPosition(props),
      width: 1,
      x: width + left,
      rect: new DOMRect(width + left, top, 1, height),
    };
  },
}));

function createSelectionPositioner(isActive: (state: EditorState) => boolean) {
  return Positioner.create<{
    from: Coords;
    to: Coords;
  }>({
    hasChanged: hasStateChanged,
    getActive: (props) => {
      const { state, view } = props;

      if (
        !isActive(state) ||
        !(isTextSelection(state.selection) || isAllSelection(state.selection))
      ) {
        return Positioner.EMPTY;
      }

      try {
        const { head, anchor } = state.selection;
        return [{ from: view.coordsAtPos(anchor), to: view.coordsAtPos(head) }];
      } catch {
        return Positioner.EMPTY;
      }
    },

    getPosition(props) {
      const { element, data, view } = props;
      const { from, to } = data;
      const parent = element.offsetParent ?? view.dom;
      const parentRect = parent.getBoundingClientRect();
      const height = Math.abs(to.bottom - from.top);

      // True when the selection spans multiple lines.
      const spansMultipleLines = height > from.bottom - from.top;

      // The position furthest to the left.
      const leftmost = Math.min(from.left, to.left);

      // The position nearest the top.
      const topmost = Math.min(from.top, to.top);

      const left =
        parent.scrollLeft +
        (spansMultipleLines ? to.left - parentRect.left : leftmost - parentRect.left);
      const top = parent.scrollTop + topmost - parentRect.top;
      const width = spansMultipleLines ? 1 : Math.abs(from.left - to.right);
      const rect = new DOMRect(spansMultipleLines ? to.left : leftmost, topmost, width, height);
      const visible = isPositionVisible(rect, view.dom);

      return { rect, y: top, x: left, height, width, visible };
    },
  });
}

/**
 * Create a position that fully capture the selected text. When the selection
 * spans multiple lines, the position is created as a box that fully captures
 * the start cursor and end cursor.
 */
export const selectionPositioner = createSelectionPositioner((state) => !state.selection.empty);

/**
 * This can be used to position a menu that is inline with the first character
 * of the selection. This is useful for suggestions since they should typically
 * appear while typing without a multi character selection.
 *
 * @remarks
 *
 * The menu will center itself within the selection.
 *
 * - `right` should be used to absolutely position away from the right hand edge
 *   of the screen.
 * - `left` should be used to absolutely position away from the left hand edge
 *   of the screen.
 * - `bottom` absolutely positions the element above the text selection.
 * - `top` absolutely positions the element below the text selection
 */
export const cursorPositioner = createSelectionPositioner((state) => state.selection.empty);

/**
 * Always render a position regardless of selection.
 */
export const alwaysPositioner = createSelectionPositioner(() => true);

/**
 * Creates a position which captures the current active word. Nothing is returned
 * if no word is active.
 *
 * This is only active when the selection is empty (cursor selection)
 *
 * @remarks
 *
 * Creates a rect that wraps the nearest word.
 */
export const nearestWordPositioner = selectionPositioner.clone(() => ({
  getActive: (props) => {
    const { state, view } = props;

    if (!state.selection.empty) {
      return Positioner.EMPTY;
    }

    const word = getSelectedWord(state);

    if (!word) {
      return Positioner.EMPTY;
    }

    try {
      return [{ from: view.coordsAtPos(word.from), to: view.coordsAtPos(word.to) }];
    } catch {
      return Positioner.EMPTY;
    }
  },
}));

export interface MarkPositionerProps {
  /**
   * The `type` of mark to look for.
   */
  type: MarkType | string;

  /**
   * When true will find all marks of the provided type in the doc.
   *
   * @defaultValue false
   */
  all?: boolean;

  /**
   * When true will only be active for the visible positions.
   *
   * @defaultValue false
   */
  onlyVisible?: boolean;
}

export interface VisibleProps {
  visible: boolean;
}

interface CreateMarkPositionerData extends GetMarkRange, VisibleProps {
  cursor: { from: Coords; to: Coords };
}

/**
 * Create a positioner for the currently selected mark
 */
export function createMarkPositioner(
  props: MarkPositionerProps,
): Positioner<CreateMarkPositionerData> {
  const { type, all = false, onlyVisible = false } = props;

  return Positioner.create({
    hasChanged: hasStateChanged,
    getActive: (props) => {
      const { state, view } = props;
      const selection = getTextSelection(all ? 'all' : state.selection, state.doc);
      try {
        const ranges = getMarkRanges(selection, type).map((range) => {
          const { from, to } = range;
          const cursor = { from: view.coordsAtPos(from), to: view.coordsAtPos(to) };
          const visible =
            isPositionVisible(getCursorRect(cursor.from), view.dom) ||
            isPositionVisible(getCursorRect(cursor.to), view.dom);

          return { ...range, visible, cursor };
        });

        return onlyVisible ? ranges.filter((range) => range.visible) : ranges;
      } catch {
        return Positioner.EMPTY;
      }
    },
    getPosition: (props) => {
      const { element, data, view } = props;
      const { cursor, visible } = data;
      const { from, to } = cursor;
      const parent = element.offsetParent ?? view.dom;
      const parentRect = parent.getBoundingClientRect();
      const height = Math.abs(to.bottom - from.top);

      // True when the selection spans multiple lines.
      const spansMultipleLines = height > from.bottom - from.top;

      // The position furthest to the left.
      const leftmost = Math.min(from.left, to.left);

      // The position nearest the top.
      const topmost = Math.min(from.top, to.top);

      const left =
        parent.scrollLeft +
        (spansMultipleLines ? to.left - parentRect.left : leftmost - parentRect.left);
      const top = parent.scrollTop + topmost - parentRect.top;
      const width = spansMultipleLines ? 1 : Math.abs(from.left - to.right);
      const rect = new DOMRect(spansMultipleLines ? to.left : leftmost, topmost, width, height);

      return { rect, y: top, x: left, height, width, visible };
    },
  });
}

function getCursorRect(coords: Coords): DOMRect {
  return new DOMRect(coords.left, coords.top, 1, coords.top - coords.bottom);
}

export const positioners = {
  /**
   * Creates a rect which wraps the current selection.
   */
  selection: selectionPositioner,

  /**
   * Creates a rect for the cursor. Is inactive for
   */
  cursor: cursorPositioner,

  /**
   * Creates a positioner which always shows the position of the selection whether empty or not.
   */
  always: alwaysPositioner,

  /**
   * Creates a position which wraps the entire selected block node.
   */
  block: blockNodePositioner,

  /**
   * Creates a position which wraps the entire selected block node. This is only active when the block node is empty.
   */
  emptyBlock: emptyBlockNodePositioner,

  /**
   * Creates a position which wraps the entire selected block node. This is only active when the block node is empty.
   */
  emptyBlockStart: emptyBlockNodeStartPositioner,

  /**
   * Creates a position which wraps the entire selected block node. This is only active when the block node is empty.
   */
  emptyBlockEnd: emptyBlockNodeEndPositioner,

  /**
   * Create a rect which surrounds the nearest word.
   */
  nearestWord: nearestWordPositioner,

  /**
   * Create a rect which surrounds the visible portion of the editor.
   */
  editor: editorPositioner,
};
