/**
 * Wrapper to properly export Svelte 5 component for webview
 */
import { mount } from 'svelte';
import Sidebar from './Sidebar.svelte';

// Export the mount function and component as globals for the webview
if (typeof window !== 'undefined') {
  window.SvelteApp = Sidebar;
  window.svelteMount = mount;
}

export default Sidebar;
