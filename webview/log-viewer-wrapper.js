/**
 * Wrapper for LogViewer Svelte component
 * Exposes component and mount function for webview instantiation
 */
import { mount } from 'svelte';
import LogViewer from './LogViewer.svelte';

// Expose for webview script
window.SvelteApp = LogViewer;
window.svelteMount = mount;
