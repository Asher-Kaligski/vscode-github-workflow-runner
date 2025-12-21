/**
 * SmartFileInputManager - Manages file favorites, recent files, and configurations
 * for the smart file input feature in workflow dispatch.
 */
import * as vscode from 'vscode';
import type {
  FileFavorite,
  RecentFile,
  SmartFileInputData,
  SmartFileInputStorageKey,
  FileContentConfig,
  ParsedFileContent,
  ParsedContentItem,
  JsonExtractionMode,
  InputValueFavorite,
} from '../types/workflow-types';

const STORAGE_KEY_PREFIX = 'githubWorkflowRunner.smartFileInput';
const MAX_RECENT_FILES = 10;
const MAX_FAVORITES = 50;
const MAX_VALUE_FAVORITES = 100;
const MAX_FILE_SUGGESTIONS = 20;

export class SmartFileInputManager {
  private static context: vscode.ExtensionContext;

  /**
   * Priority keys for JSON extraction - common field names sorted by preference.
   * Used when suggesting keys to extract from JSON arrays of objects.
   */
  private static readonly PRIORITY_KEYS = ['tag', 'name', 'id', 'key', 'value', 'label'] as const;

  /**
   * Initialize the manager with extension context
   */
  static initialize(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  /**
   * Generate storage key string from key object
   */
  private static getStorageKeyString(key: SmartFileInputStorageKey): string {
    const base = `${STORAGE_KEY_PREFIX}.${key.owner}.${key.repo}.${key.workflowFilename}`;
    return key.inputName ? `${base}.${key.inputName}` : base;
  }

  /**
   * Sort an array of key names by priority, putting common keys first.
   * Keys are matched case-insensitively against PRIORITY_KEYS.
   */
  private static sortKeysByPriority(keys: string[]): void {
    keys.sort((a, b) => {
      const aIdx = this.PRIORITY_KEYS.indexOf(
        a.toLowerCase() as (typeof this.PRIORITY_KEYS)[number]
      );
      const bIdx = this.PRIORITY_KEYS.indexOf(
        b.toLowerCase() as (typeof this.PRIORITY_KEYS)[number]
      );
      if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
      if (aIdx >= 0) return -1;
      if (bIdx >= 0) return 1;
      return 0;
    });
  }

  /**
   * Get smart file input data for a specific scope
   */
  static async getData(key: SmartFileInputStorageKey): Promise<SmartFileInputData> {
    const storageKey = this.getStorageKeyString(key);
    const data = this.context.globalState.get<SmartFileInputData>(storageKey);
    return data || { recentFiles: [], favorites: [] };
  }

  /**
   * Save smart file input data
   */
  static async saveData(key: SmartFileInputStorageKey, data: SmartFileInputData): Promise<void> {
    const storageKey = this.getStorageKeyString(key);
    await this.context.globalState.update(storageKey, data);
  }

  /**
   * Save value favorites for a specific input
   */
  static async saveValueFavorites(
    key: SmartFileInputStorageKey,
    favorites: InputValueFavorite[]
  ): Promise<InputValueFavorite[]> {
    const data = await this.getData(key);
    // Limit to max value favorites
    data.valueFavorites = favorites.slice(0, MAX_VALUE_FAVORITES);
    await this.saveData(key, data);
    return data.valueFavorites;
  }

  /**
   * Get value favorites for a specific input
   */
  static async getValueFavorites(key: SmartFileInputStorageKey): Promise<InputValueFavorite[]> {
    const data = await this.getData(key);
    return data.valueFavorites || [];
  }

  /**
   * Track a file as recently used
   */
  static async trackRecentFile(
    key: SmartFileInputStorageKey,
    relativePath: string,
    absolutePath: string,
    config?: FileContentConfig,
    mode?: 'path' | 'content'
  ): Promise<void> {
    const data = await this.getData(key);
    const now = Date.now();

    // Find existing entry
    const existingIndex = data.recentFiles.findIndex((f) => f.relativePath === relativePath);

    if (existingIndex >= 0) {
      // Update existing entry
      data.recentFiles[existingIndex].lastUsedAt = now;
      data.recentFiles[existingIndex].useCount += 1;
      if (config) {
        data.recentFiles[existingIndex].lastConfig = config;
      }
      if (mode) {
        data.recentFiles[existingIndex].lastMode = mode;
      }
    } else {
      // Add new entry
      data.recentFiles.unshift({
        relativePath,
        absolutePath,
        lastUsedAt: now,
        useCount: 1,
        lastConfig: config,
        lastMode: mode,
      });
    }

    // Sort by lastUsedAt (most recent first) and limit to MAX_RECENT_FILES
    data.recentFiles.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    data.recentFiles = data.recentFiles.slice(0, MAX_RECENT_FILES);

    await this.saveData(key, data);
  }

  /**
   * Add a file to favorites
   */
  static async addFavorite(
    key: SmartFileInputStorageKey,
    relativePath: string,
    absolutePath: string,
    nickname?: string,
    config?: FileContentConfig
  ): Promise<FileFavorite> {
    const data = await this.getData(key);

    // Check if already exists
    const existing = data.favorites.find((f) => f.relativePath === relativePath);
    if (existing) {
      throw new Error('File is already in favorites');
    }

    // Check limit
    if (data.favorites.length >= MAX_FAVORITES) {
      throw new Error(`Maximum ${MAX_FAVORITES} favorites allowed`);
    }

    const favorite: FileFavorite = {
      id: this.generateUUID(),
      relativePath,
      absolutePath,
      nickname,
      config,
      addedAt: Date.now(),
    };

    data.favorites.push(favorite);
    await this.saveData(key, data);

    return favorite;
  }

  /**
   * Remove a file from favorites
   */
  static async removeFavorite(key: SmartFileInputStorageKey, favoriteId: string): Promise<void> {
    const data = await this.getData(key);
    const index = data.favorites.findIndex((f) => f.id === favoriteId);

    if (index === -1) {
      throw new Error('Favorite not found');
    }

    data.favorites.splice(index, 1);
    await this.saveData(key, data);
  }

  /**
   * Update a favorite (nickname, config, etc.)
   */
  static async updateFavorite(
    key: SmartFileInputStorageKey,
    favoriteId: string,
    updates: Partial<Pick<FileFavorite, 'nickname' | 'config'>>
  ): Promise<FileFavorite> {
    const data = await this.getData(key);
    const favorite = data.favorites.find((f) => f.id === favoriteId);

    if (!favorite) {
      throw new Error('Favorite not found');
    }

    if (updates.nickname !== undefined) {
      favorite.nickname = updates.nickname;
    }
    if (updates.config !== undefined) {
      favorite.config = updates.config;
    }
    favorite.lastUsedAt = Date.now();

    await this.saveData(key, data);
    return favorite;
  }

  /**
   * Parse file content for multi-select display
   */
  static parseFileContent(
    content: string,
    filePath: string,
    config?: Partial<FileContentConfig>
  ): ParsedFileContent {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    let fileType: ParsedFileContent['fileType'] = 'text';
    let items: ParsedContentItem[] = [];
    let availableExtractionModes: JsonExtractionMode[] = ['full'];
    let suggestedKeys: string[] | undefined;
    let structure: string | undefined;
    let nestedArrays: Record<string, string[]> | undefined;
    let selectedArrayPath: string | undefined;

    if (ext === 'json') {
      fileType = 'json';
      try {
        const parsed = JSON.parse(content);
        const result = this.parseJsonContent(parsed, config);
        items = result.items;
        availableExtractionModes = result.availableExtractionModes;
        suggestedKeys = result.suggestedKeys;
        structure = result.structure;
        nestedArrays = result.nestedArrays;
        selectedArrayPath = result.selectedArrayPath;
      } catch {
        // Fall back to line-by-line parsing
        items = this.parseTextContent(content);
      }
    } else if (ext === 'yaml' || ext === 'yml') {
      fileType = 'yaml';
      // For now, treat YAML as text (could add yaml parsing later)
      items = this.parseTextContent(content);
    } else if (ext === 'csv') {
      fileType = 'csv';
      items = this.parseCsvContent(content);
    } else {
      items = this.parseTextContent(content);
    }

    return {
      items,
      fileType,
      structure,
      availableExtractionModes,
      suggestedKeys,
      nestedArrays,
      selectedArrayPath,
    };
  }

  /**
   * Parse JSON content for selection
   */
  private static parseJsonContent(
    data: unknown,
    config?: Partial<FileContentConfig>
  ): Omit<ParsedFileContent, 'fileType'> {
    const items: ParsedContentItem[] = [];
    let availableExtractionModes: JsonExtractionMode[] = ['full'];
    let suggestedKeys: string[] | undefined;
    let structure: string | undefined;

    // Handle arrays (most common case for workflow inputs)
    if (Array.isArray(data)) {
      structure = 'array';
      availableExtractionModes = ['full', 'property-names', 'property-values', 'specific-key'];

      // If array of objects, extract common keys as suggestions
      if (data.length > 0 && typeof data[0] === 'object' && data[0] !== null) {
        const firstObj = data[0] as Record<string, unknown>;
        suggestedKeys = Object.keys(firstObj).filter(
          (k) => typeof firstObj[k] === 'string' || typeof firstObj[k] === 'number'
        );

        // Sort by priority keys (tag, name, id, etc.)
        this.sortKeysByPriority(suggestedKeys);
      }

      const extractionMode = config?.jsonExtractionMode || 'full';
      const specificKey = config?.jsonSpecificKey || suggestedKeys?.[0];

      data.forEach((item, index) => {
        let display: string;
        let value: string;

        if (typeof item === 'object' && item !== null) {
          const obj = item as Record<string, unknown>;

          if (extractionMode === 'specific-key' && specificKey && specificKey in obj) {
            display = String(obj[specificKey]);
            value = String(obj[specificKey]);
          } else if (extractionMode === 'property-names') {
            display = Object.keys(obj).join(', ');
            value = Object.keys(obj).join(',');
          } else {
            // Full object or default
            display = obj['name'] ? String(obj['name']) : JSON.stringify(item);
            value = JSON.stringify(item);
          }
        } else {
          display = String(item);
          value = String(item);
        }

        items.push({
          display,
          value,
          source: `[${index}]`,
          selected: true, // Select all by default
        });
      });
    } else if (typeof data === 'object' && data !== null) {
      // Handle objects with key-value pairs
      const obj = data as Record<string, unknown>;

      // Detect nested arrays of objects
      const nestedArrays: Record<string, string[]> = {};
      Object.entries(obj).forEach(([key, val]) => {
        if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
          const firstItem = val[0] as Record<string, unknown>;
          const stringKeys = Object.keys(firstItem).filter(
            (k) => typeof firstItem[k] === 'string' || typeof firstItem[k] === 'number'
          );
          if (stringKeys.length > 0) {
            // Sort by priority keys (tag, name, id, etc.)
            this.sortKeysByPriority(stringKeys);
            nestedArrays[key] = stringKeys;
          }
        }
      });

      const hasNestedArrays = Object.keys(nestedArrays).length > 0;
      const arrayPath = config?.jsonArrayPath;
      const extractionMode = config?.jsonExtractionMode || 'full';
      const specificKey = config?.jsonSpecificKey;

      // If we have a selected array path, extract from that array
      if (arrayPath && arrayPath in nestedArrays && Array.isArray(obj[arrayPath])) {
        structure = 'nested-array';
        availableExtractionModes = ['full', 'property-names', 'property-values', 'specific-key'];
        suggestedKeys = nestedArrays[arrayPath];

        const nestedArray = obj[arrayPath] as Array<Record<string, unknown>>;
        const keyToExtract = specificKey || suggestedKeys?.[0];

        nestedArray.forEach((item, index) => {
          let display: string;
          let value: string;

          if (extractionMode === 'specific-key' && keyToExtract && keyToExtract in item) {
            display = String(item[keyToExtract]);
            value = String(item[keyToExtract]);
          } else if (extractionMode === 'property-names') {
            display = Object.keys(item).join(', ');
            value = Object.keys(item).join(',');
          } else {
            display = item['name'] ? String(item['name']) : JSON.stringify(item);
            value = JSON.stringify(item);
          }

          items.push({
            display,
            value,
            source: `${arrayPath}[${index}]`,
            selected: true,
          });
        });

        return {
          items,
          availableExtractionModes,
          suggestedKeys,
          structure,
          nestedArrays,
          selectedArrayPath: arrayPath,
        };
      }

      // Default: show top-level key-value pairs
      structure = hasNestedArrays ? 'object-with-arrays' : 'object';
      availableExtractionModes = ['full', 'property-names', 'property-values'];

      Object.entries(obj).forEach(([key, val]) => {
        const strVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
        items.push({
          display: `${key}: ${strVal.substring(0, 50)}${strVal.length > 50 ? '...' : ''}`,
          value: strVal,
          source: key,
          selected: true,
        });
      });

      return {
        items,
        availableExtractionModes,
        suggestedKeys,
        structure,
        nestedArrays: hasNestedArrays ? nestedArrays : undefined,
      };
    }

    return { items, availableExtractionModes, suggestedKeys, structure };
  }

  /**
   * Parse text content line by line
   */
  private static parseTextContent(content: string): ParsedContentItem[] {
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line, index) => ({
        display: line.substring(0, 100) + (line.length > 100 ? '...' : ''),
        value: line,
        source: `line ${index + 1}`,
        selected: true,
      }));
  }

  /**
   * Parse CSV content
   */
  private static parseCsvContent(content: string): ParsedContentItem[] {
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    const items: ParsedContentItem[] = [];

    lines.forEach((line, index) => {
      // Simple CSV parsing (doesn't handle quoted commas)
      const cells = line.split(',').map((c) => c.trim());
      items.push({
        display: cells.join(' | '),
        value: line,
        source: `row ${index + 1}`,
        selected: index > 0, // Skip header row by default
      });
    });

    return items;
  }

  /**
   * Generate UUID v4
   */
  private static generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Get file suggestions based on partial path
   */
  static async getFileSuggestions(
    workspaceRoot: string,
    partialPath: string,
    limit: number = MAX_FILE_SUGGESTIONS
  ): Promise<string[]> {
    const suggestions: string[] = [];

    try {
      const workspaceUri = vscode.Uri.file(workspaceRoot);
      const searchPattern = partialPath
        ? new vscode.RelativePattern(workspaceUri, `**/${partialPath}*`)
        : new vscode.RelativePattern(workspaceUri, '**/*');

      const files = await vscode.workspace.findFiles(searchPattern, '**/node_modules/**', limit);

      for (const file of files) {
        const relativePath = vscode.workspace.asRelativePath(file);
        suggestions.push(relativePath);
      }
    } catch (error) {
      console.error('Error getting file suggestions:', error);
    }

    return suggestions;
  }

  /**
   * Join selected values with delimiter
   */
  static joinValues(values: string[], config: FileContentConfig): string {
    let delimiter: string;

    switch (config.delimiter) {
      case 'comma':
        delimiter = ', ';
        break;
      case 'pipe':
        delimiter = ' | ';
        break;
      case 'newline':
        delimiter = '\n';
        break;
      case 'space':
        delimiter = ' ';
        break;
      case 'custom':
        delimiter = config.customDelimiter || ', ';
        break;
      default:
        delimiter = ', ';
    }

    return values.join(delimiter);
  }
}
