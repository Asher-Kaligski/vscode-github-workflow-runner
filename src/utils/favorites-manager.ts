/**
 * Favorites Manager - Manages workflow favorites storage and operations
 */
import * as vscode from 'vscode';
import type { WorkflowFavorite } from '../types/workflow-types';

export class FavoritesManager {
    private static context: vscode.ExtensionContext;

    /**
     * Initialize the favorites manager with extension context
     */
    static initialize(context: vscode.ExtensionContext): void {
        this.context = context;
    }

    /**
     * Add a new favorite
     */
    static async addFavorite(favorite: Omit<WorkflowFavorite, 'id' | 'addedAt'>): Promise<WorkflowFavorite> {
        // Validate input
        if (!favorite.workflowName?.trim()) {
            throw new Error('Workflow name is required');
        }
        if (!favorite.workflowFilename?.match(/\.ya?ml$/)) {
            throw new Error('Workflow filename must end with .yml or .yaml');
        }
        if (!favorite.repository?.owner || !favorite.repository?.name) {
            throw new Error('Repository owner and name are required');
        }

        const newFavorite: WorkflowFavorite = {
            ...favorite,
            id: this.generateUUID(),
            addedAt: Date.now()
        };

        const favorites = await this.getFavorites();
        favorites.push(newFavorite);
        await this.saveFavorites(favorites);

        return newFavorite;
    }

    /**
     * Remove a favorite by ID
     */
    static async removeFavorite(id: string): Promise<void> {
        const favorites = await this.getFavorites();
        const filtered = favorites.filter(f => f.id !== id);

        if (filtered.length === favorites.length) {
            throw new Error(`Favorite with ID ${id} not found`);
        }

        await this.saveFavorites(filtered);
    }

    /**
     * Update a favorite
     */
    static async updateFavorite(id: string, updates: Partial<Omit<WorkflowFavorite, 'id' | 'addedAt'>>): Promise<WorkflowFavorite> {
        const favorites = await this.getFavorites();
        const index = favorites.findIndex(f => f.id === id);

        if (index === -1) {
            throw new Error(`Favorite with ID ${id} not found`);
        }

        favorites[index] = { ...favorites[index], ...updates };
        await this.saveFavorites(favorites);

        return favorites[index];
    }

    /**
     * Get all favorites, optionally filtered by repository
     */
    static async getFavorites(repository?: { owner: string; name: string }): Promise<WorkflowFavorite[]> {
        const config = vscode.workspace.getConfiguration('githubWorkflowRunner');
        const scope = config.get<'workspace' | 'global'>('favorites.scope', 'workspace');
        const storage = scope === 'workspace' ? this.context.workspaceState : this.context.globalState;

        const favorites = storage.get<WorkflowFavorite[]>('githubWorkflowRunner.favorites', []);

        if (repository) {
            return favorites.filter(f =>
                f.repository.owner === repository.owner &&
                f.repository.name === repository.name
            );
        }

        return favorites;
    }

    /**
     * Save favorites to storage
     */
    private static async saveFavorites(favorites: WorkflowFavorite[]): Promise<void> {
        // Enforce maximum limit
        const MAX_FAVORITES = 100;
        if (favorites.length > MAX_FAVORITES) {
            throw new Error(`Maximum ${MAX_FAVORITES} favorites allowed`);
        }

        const config = vscode.workspace.getConfiguration('githubWorkflowRunner');
        const scope = config.get<'workspace' | 'global'>('favorites.scope', 'workspace');
        const storage = scope === 'workspace' ? this.context.workspaceState : this.context.globalState;

        await storage.update('githubWorkflowRunner.favorites', favorites);
    }

    /**
     * Generate a UUID v4
     */
    private static generateUUID(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    /**
     * Validate a favorite object
     */
    static validateFavorite(favorite: WorkflowFavorite): string[] {
        const errors: string[] = [];

        if (!favorite.id || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(favorite.id)) {
            errors.push('Invalid UUID');
        }

        if (!favorite.workflowName?.trim()) {
            errors.push('Workflow name is required');
        }

        if (!favorite.workflowFilename?.match(/\.ya?ml$/)) {
            errors.push('Workflow filename must end with .yml or .yaml');
        }

        if (!favorite.repository?.owner || !favorite.repository?.name) {
            errors.push('Repository owner and name are required');
        }

        if (favorite.addedAt <= 0) {
            errors.push('Invalid timestamp');
        }

        return errors;
    }
}

