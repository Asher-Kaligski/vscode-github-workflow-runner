/**
 * Wrapper to properly export Svelte 5 component for webview
 */
import { mount } from 'svelte';
import WorkflowRuns from './WorkflowRuns.svelte';

// Export the mount function and component as globals for the webview
if (typeof window !== 'undefined') {
  window.SvelteApp = WorkflowRuns;
  window.svelteMount = mount;
}

export default WorkflowRuns;
