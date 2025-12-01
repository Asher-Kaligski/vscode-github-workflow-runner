/**
 * Global type definitions for webview
 */

interface VsCodeApi {
    postMessage(message: any): void;
    getState(): any;
    setState(state: any): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

declare const vscode: VsCodeApi;
