import { Schema } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { suggest, Suggester } from 'prosemirror-suggest';

import {
  ErrorConstant,
  REMIRROR_IDENTIFIER_KEY,
  RemirrorIdentifier,
} from '@remirror/core-constants';
import {
  freeze,
  invariant,
  isArray,
  isEqual,
  isIdentifierOfType,
  isRemirrorType,
  object,
} from '@remirror/core-helpers';
import {
  AttributesWithClass,
  EditorSchema,
  EditorStateParameter,
  EditorView,
  MarkExtensionSpec,
  NodeExtensionSpec,
  NodeViewMethod,
  PlainObject,
  ProsemirrorAttributes,
  ProsemirrorPlugin,
  TransactionParameter,
} from '@remirror/core-types';
import { createDocumentNode, CreateDocumentNodeParams } from '@remirror/core-utils';

import {
  AnyExtension,
  ExtensionTags,
  GetMarkNameUnion,
  GetNodeNameUnion,
  InitializeEventMethodParameter,
  InitializeEventMethodReturn,
  isMarkExtension,
  isNodeExtension,
  SchemaFromExtension,
} from '../extension';
import { AnyPreset } from '../preset';
import { GetCommands, GetConstructor, ManagerParameter, ManagerSettings } from '../types';
import {
  createAttributes,
  createCommands,
  createExtensionTags,
  createHelpers,
  defaultIsActive,
  defaultIsEnabled,
  getParameterWithType,
  ignoreFunctions,
  ManagerPhase,
  transformExtensionOrPreset as transformExtensionOrPresetList,
} from './manager-helpers';

/* eslint-disable @typescript-eslint/explicit-member-accessibility */

/**
 * A type that matches any manager.
 */
type AnyManager = Manager;

/**
 * Checks to see whether the provided value is an `Manager`.
 *
 * @param value - the value to check
 */
const isManager = (value: unknown): value is AnyManager =>
  isRemirrorType(value) && isIdentifierOfType(value, RemirrorIdentifier.Manager);

/**
 * The `Manager` has multiple hook phases which are able to hook into
 * the extension manager flow and add new functionality to the editor.
 *
 * The `ExtensionEventMethod`s
 *
 * - onConstruct - when the extension manager is created and after the schema is
 *   made available.
 * - onInit - when the editor manager is initialized within the component
 * - onView - when the view has been received from the dom ref.
 */

/**
 * A class to manage the extensions and prosemirror interactions of our editor.
 *
 * @remarks
 *
 * The extension manager has three phases of Initialization:
 *
 * - Construction - This takes in all the extensions and creates the schema.
 *
 * ```ts
 * const manager = Manager.create([ new DocExtension(), new TextExtension(), new ParagraphExtension()])
 * ```
 *
 * - Initialize Getters - This connects the extension manager to the lazily
 *   evaluated `getState` method and the `portalContainer`. Once these are
 *   created and allows access to its data.
 *
 * ```ts
 * manager.init({ getState: () => state, portalContainer: new PortalContainer })
 *
 * manager.data.
 * ```
 *
 * - Initialize View - This connects the extension manager to the EditorView and
 *   creates the actions (which need access to the view).
 *
 * ```ts
 * manager.initView(new EditorView(...))
 * manager.data.actions
 * ```
 */
class Manager<
  ExtensionUnion extends AnyExtension = any,
  PresetUnion extends AnyPreset<ExtensionUnion> = any
> {
  /**
   * A static method for creating a manager.
   */
  public static of<
    ExtensionUnion extends AnyExtension,
    PresetUnion extends AnyPreset<ExtensionUnion>
  >(extensionOrPresetList: Array<ExtensionUnion | PresetUnion>, settings: ManagerSettings) {
    return new Manager<ExtensionUnion, PresetUnion>(extensionOrPresetList, settings);
  }

  /**
   * Identifies this as a `Manager`.
   *
   * @internal
   */
  get [REMIRROR_IDENTIFIER_KEY]() {
    return RemirrorIdentifier.Manager;
  }

  #extensions: readonly ExtensionUnion[];
  #extensionMap: WeakMap<GetConstructor<ExtensionUnion>, ExtensionUnion>;

  /**
   * The extensions stored by this manager
   */
  get extensions() {
    return this.#extensions;
  }

  #presets: readonly PresetUnion[];
  #presetMap: WeakMap<GetConstructor<PresetUnion>, PresetUnion>;

  /**
   * The preset stored by this manager
   */
  get presets(): readonly PresetUnion[] {
    return this.#presets;
  }

  /**
   * The extension manager store.
   */
  #store: Remirror.ManagerStore<ExtensionUnion> = this.createInitialStore();

  /**
   * The stage the manager is currently running.
   */
  #phase: ManagerPhase = ManagerPhase.None;

  #settings: ManagerSettings;

  /**
   * Get the extension manager store which is accessible at initialization.
   */
  get store() {
    return freeze(this.#store);
  }

  /**
   * Returns the stored nodes
   */
  get nodes() {
    return this.#store.nodes;
  }

  /**
   * Returns the store marks.
   */
  get marks() {
    return this.#store.marks;
  }

  /**
   * A shorthand method for retrieving the schema for this extension manager
   * from the data.
   */
  get schema() {
    return this.#store.schema;
  }

  /**
   * A shorthand getter for retrieving the tags from the extension manager.
   */
  get tags() {
    return this.#store.tags;
  }

  /**
   * A shorthand way of retrieving the editor view.
   */
  get view(): EditorView<SchemaFromExtension<ExtensionUnion>> {
    return this.view;
  }

  /* Private Get Properties */

  /**
   * Utility getter for accessing the parameter which is passed to the
   * extension methods
   */
  private get parameter(): ManagerParameter<SchemaFromExtension<ExtensionUnion>> {
    return {
      tags: this.tags,
      schema: this.schema,
      getState: this.getState,
      commands: () => ({}),
      helpers: () => ({}),
      chain: () => ({}),
    };
  }

  #onInitializeHandlers: InitializeEventMethodReturn[] = [];

  /**
   * Creates the extension manager which is used to simplify the management of
   * the prosemirror editor.
   *
   * This should not be called directly if you want to use prioritized
   * extensions. Instead use `Manager.create`.
   */
  private constructor(
    extensionOrPresetList: Array<ExtensionUnion | PresetUnion>,
    settings: ManagerSettings,
  ) {
    this.#settings = settings;

    const { extensions, extensionMap, presets, presetMap } = transformExtensionOrPresetList<
      ExtensionUnion,
      PresetUnion
    >(extensionOrPresetList);

    this.#extensions = freeze(extensions);
    this.#extensionMap = extensionMap;
    this.#presets = freeze(presets);
    this.#presetMap = presetMap;

    const parameter = this.initializeParameter;
    this.createDefaultOnInitializeMethods(parameter);

    for (const extension of this.#extensions) {
      if (isNodeExtension(extension)) {
        const { name, schema } = extension;
        this.#store.nodes[name as GetNodeNameUnion<ExtensionUnion>] = schema;
      }

      if (isMarkExtension(extension)) {
        const { name, #schema: schema } = extension;

        this.#store.marks[name as GetMarkNameUnion<ExtensionUnion>] = schema;
      }

      const handlers = extension.parameter.onInitialize?.(parameter);

      if (handlers) {
        this.#onInitializeHandlers.push(handlers);
      }
    }

    // Initialize the schema and tags immediately since these don't ever change.
    this.#store.schema = this.createSchema();
    this.#store.tags = freeze(createExtensionTags(this.extensions));

    this.initialize();
  }

  private get initializeParameter(): InitializeEventMethodParameter {
    return {
      getParameter: (extension) => {
        invariant(this.#phase >= ManagerPhase.Initialize, {
          code: ErrorConstant.MANAGER_PHASE_ERROR,
          message: '`getParameter` should only be called within the returned methods scope.',
        });

        return getParameterWithType(extension, this.parameter);
      },
      addPlugins: this.addPlugins,
      getStoreKey: this.getStoreKey,
      setStoreKey: this.setStoreKey,
      managerSettings: this.#settings,
    };
  }

  /**
   * Set the store key.
   */
  private readonly setStoreKey = <Key extends keyof Remirror.ManagerStore>(
    key: Key,
    value: Remirror.ManagerStore[Key],
  ) => {
    invariant(this.#phase > ManagerPhase.Initialize, {
      code: ErrorConstant.MANAGER_PHASE_ERROR,
      message: '`setStoreKey` should only be called within the returned methods scope.',
    });

    this.#store[key] = value;
  };

  private readonly getStoreKey = <Key extends keyof Remirror.ManagerStore>(
    key: Key,
  ): Remirror.ManagerStore[Key] => {
    invariant(this.#phase >= ManagerPhase.Initialize, {
      code: ErrorConstant.MANAGER_PHASE_ERROR,
      message: '`getStoreKey` should only be called within the returned methods scope.',
    });

    return this.#store[key];
  };

  private readonly addPlugins = (...plugins: ProsemirrorPlugin[]) => {
    this.#store.plugins.push(...plugins);
  };

  /**
   * Create the default on initialize methods.
   */
  private createDefaultOnInitializeMethods(parameter: InitializeEventMethodParameter) {
    [createAttributes].forEach((method) => this.#onInitializeHandlers.push(method(parameter)));
  }

  /**
   * Called before the extension loop of the initialization phase.
   */
  private beforeInitialize() {
    for (const { beforeExtensionLoop } of this.#onInitializeHandlers) {
      beforeExtensionLoop?.();
    }
  }

  /**
   * Called after the extension loop of the initialization phase.
   */
  private afterInitialize() {
    for (const { afterExtensionLoop } of this.#onInitializeHandlers) {
      afterExtensionLoop?.();
    }
  }

  /**
   * Called during the extension loop of the initialization phase.
   */
  private initializeEachExtension(extension: ExtensionUnion) {
    for (const { forEachExtension } of this.#onInitializeHandlers) {
      forEachExtension?.(extension);
    }
  }

  /**
   * Initialize the extension manager with important data.
   *
   * This is called by the view layer and provides
   */
  private initialize() {
    this.#phase = ManagerPhase.Initialize;

    this.beforeInitialize();

    for (const extension of this.#extensions) {
      this.initializeEachExtension(extension);
    }

    this.afterInitialize();

    this.#store.pasteRules = this.pasteRules();
    this.#store.suggestions = this.suggestions();

    this.#store.plugins = [
      ...this.#store.extensionPlugins,
      this.#store.suggestions,
      ...this.#store.pasteRules,
      ...this.#store.keymaps,
    ];

    // this.#store.helpers = this.helpers();
  }

  /**
   * Create the initial store.
   */
  private createInitialStore() {
    const store: Remirror.ManagerStore<ExtensionUnion> = object();

    store.nodes = object();
    store.marks = object();
    store.plugins = [];

    return store;
  }

  /**
   * Stores the editor view on the manager
   *
   * @param view - the editor view
   */
  public addView(view: EditorView<SchemaFromExtension<ExtensionUnion>>) {
    this.#phase = ManagerPhase.AddView;
    this.#store.view = view;

    this.#store.commands = this.createCommands({
      ...this.parameter,
      view,
      isEditable: () => view.props.editable?.(this.getState()) ?? false,
    });

    this.#phase = ManagerPhase.Done;
  }

  /**
   * A state getter method which is passed into the params.
   */
  private getState() {
    invariant(this.#phase >= ManagerPhase.AddView, {
      code: ErrorConstant.MANAGER_PHASE_ERROR,
      message:
        '`getState` can only be called after the view has been added to the manager. Avoid using it in the outer scope of `creatorMethods`.',
    });

    return this.view.state;
  }

  /* Public Methods */

  /**
   * Create the editor state from content passed to this extension manager.
   */
  public createState({
    content,
    doc,
    stringHandler,
    fallback,
  }: Omit<CreateDocumentNodeParams, 'schema'>) {
    const { schema, plugins } = this.store;
    return EditorState.create({
      schema,
      doc: createDocumentNode({
        content,
        doc,
        schema,
        stringHandler,
        fallback,
      }),
      plugins,
    });
  }

  /**
   * Checks whether two manager's are equal. Can be used to determine whether a
   * change in props has caused anything to actually change and prevent a
   * rerender.
   *
   * Managers are equal when
   * - They have the same number of extensions
   * - Same order of extensions
   * - Each extension has the same options (ignoring methods)
   *
   * @param otherManager - the value to test against
   */
  public isEqual(otherManager: unknown) {
    if (!isManager(otherManager)) {
      return false;
    }

    const manager = otherManager;

    if (this.extensions.length !== manager.extensions.length) {
      return false;
    }

    for (let ii = 0; ii <= this.extensions.length - 1; ii++) {
      const extension = this.extensions[ii];
      const otherExtension = manager.extensions[ii];

      if (
        extension.constructor === otherExtension.constructor &&
        isEqual(ignoreFunctions(extension.settings), ignoreFunctions(otherExtension.options))
      ) {
        continue;
      }
      return false;
    }

    return true;
  }

  /**
   * A handler which allows the extension to respond to each transaction without
   * needing to register a plugin.
   *
   * This is currently used in the collaboration plugin.
   */
  public onTransaction(parameters: OnTransactionManagerParams) {
    this.extensions.filter(hasExtensionProperty('onTransaction')).forEach(({ onTransaction }) => {
      onTransaction({ ...parameters, ...this.parameter, view: this.store.view });
    });
  }

  /**
   * Dynamically create the editor schema based on the extensions that have been
   * passed in.
   *
   * This is called as soon as the Manager is created.
   */
  private createSchema(): EditorSchema<
    GetNodeNameUnion<ExtensionUnion>,
    GetMarkNameUnion<ExtensionUnion>
  > {
    return new Schema({ nodes: this.nodes, marks: this.marks });
  }

  /**
   * Create the actions which are passed into the render props.
   *
   * RemirrorActions allow for checking if a node / mark is active, enabled, and
   * also running the command.
   *
   * - `isActive` defaults to a function returning false
   * - `isEnabled` defaults to a function returning true
   */
  private createCommands(parameters: CommandParameter): this['~C'] {
    // Will throw if not initialized
    this.checkInitialized();

    const extensions = this.extensions;
    const actions: AnyCommands = object();

    // Creates the methods that take in attrs and dispatch an action into the
    // editor
    const commands = createCommands({ extensions, params: parameters });

    Object.entries(commands).forEach(([commandName, { command, isEnabled, name }]) => {
      const isActive = this.#store.isActive[name as this['_Names']] ?? defaultIsActive;

      actions[commandName] = command as CommandMethod;
      actions[commandName].isActive = (attributes: ProsemirrorAttributes) =>
        isActive({ attrs: attributes });
      actions[commandName].isEnabled = isEnabled ?? defaultIsEnabled;
    });

    return actions as this['~C'];
  }

  private createHelpers(): this['_H'] {
    const helpers = object<PlainObject>();
    const methods = createHelpers({ extensions: this.extensions, params: this.parameter });

    Object.entries(methods).forEach(([helperName, helper]) => {
      helpers[helperName] = helper;
    });

    return helpers as this['_H'];
  }

  /**
   * Retrieve the nodeViews created on the extensions for use within prosemirror
   * state
   */
  private nodeViews() {
    this.checkInitialized();
    const nodeViews: Record<string, NodeViewMethod> = object();
    return this.extensions
      .filter(hasExtensionProperty('nodeView'))
      .filter((extension) => !extension.options.exclude.nodeView)
      .reduce(
        (previousNodeViews, extension) => ({
          ...previousNodeViews,
          [extension.name]: extensionPropertyMapper(
            'nodeView',
            this.parameter,
          )(extension) as NodeViewMethod,
        }),
        nodeViews,
      );
  }

  /**
   * Retrieve all pasteRules (rules for how the editor responds to pastedText).
   */
  private pasteRules(): ProsemirrorPlugin[] {
    this.checkInitialized();
    const pasteRules: ProsemirrorPlugin[] = [];
    const extensionPasteRules = this.extensions
      .filter(hasExtensionProperty('pasteRules'))
      .filter((extension) => !extension.options.exclude.pasteRules)
      .map(extensionPropertyMapper('pasteRules', this.parameter));

    extensionPasteRules.forEach((rules) => {
      pasteRules.push(...rules);
    });

    return pasteRules;
  }

  private suggestions() {
    const suggestions: Suggester[] = [];

    const extensionSuggesters = this.extensions
      .filter(hasExtensionProperty('suggestions'))
      .filter((extension) => !extension.options.exclude.suggestions)
      .map(extensionPropertyMapper('suggestions', this.parameter));

    extensionSuggesters.forEach((suggester) => {
      suggestions.push(...(isArray(suggester) ? suggester : [suggester]));
    });

    return suggest(...suggestions);
  }

  /**
   * Called when removing the manager and all preset and extensions.
   */
  public destroy() {
    for (const extension of this.extensions) {
      extension.destroy?.();
    }
  }
}

interface ManagerParams<
  ExtensionUnion extends AnyExtension = any,
  PresetUnion extends AnyPreset<ExtensionUnion> = any
> {
  /**
   * The extension manager
   */
  manager: Manager<ExtensionUnion, PresetUnion>;
}

interface OnTransactionManagerParams extends TransactionParameter, EditorStateParameter {}

declare global {
  namespace Remirror {
    /**
     * Describes the object where the extension manager stores it's data.
     *
     * @remarks
     *
     * Since this is a global namespace, you can extend the store if your
     * extension is modifying the shape of the `Manager.store` property.
     */
    interface ManagerStore<ExtensionUnion extends AnyExtension = any> {
      /**
       * The nodes to place on the schema.
       */
      nodes: Record<GetNodeNameUnion<ExtensionUnion>, NodeExtensionSpec>;

      /**
       * The marks to be added to the schema.
       */
      marks: Record<GetMarkNameUnion<ExtensionUnion>, MarkExtensionSpec>;

      /**
       * The editor view stored by this instance.
       */
      view: EditorView<SchemaFromExtension<ExtensionUnion>>;

      /**
       * Store the built in and custom tags for the editor instance.
       */
      tags: Readonly<ExtensionTags<ExtensionUnion>>;

      /**
       * The attributes to be added to the prosemirror editor.
       */
      attributes: AttributesWithClass;

      /**
       * The schema created by this extension manager.
       */
      schema: SchemaFromExtension<ExtensionUnion>;

      /**
       * All the plugins defined by the extensions.
       */
      extensionPlugins: ProsemirrorPlugin[];

      /**
       * All of the plugins combined together from all sources
       */
      plugins: ProsemirrorPlugin[];

      /**
       * The keymap arrangement.
       */
      keymaps: ProsemirrorPlugin[];

      /**
       * The paste rules for editor. This determines what happens when the user
       * pastes content into the editor.
       */
      pasteRules: ProsemirrorPlugin[];

      /**
       * The suggestions to be added to the editor instance.
       */
      suggestions: ProsemirrorPlugin;

      /**
       * The commands defined within this extension.
       */
      commands: GetCommands<ExtensionUnion>;
    }

    /**
     * The initialization params which are passed by the view layer into the
     * extension manager. This can be added to by the requesting framework layer.
     */
    interface ManagerInitializationParams<ExtensionUnion extends AnyExtension = any> {}
  }
}

/* eslint-enable @typescript-eslint/explicit-member-accessibility */

export { AnyManager, isManager, Manager, ManagerParams, OnTransactionManagerParams };
