// Codia's consumed API subset of pinned Cubism 5-r.5 (not the full upstream SDK).
export class Option { loggingLevel: number; logFunction: (text: string) => void; }
export const LogLevel: { LogLevel_Warning: number };
export const CubismFramework: {
  isStarted(): boolean; isInitialized(): boolean;
  startUp(option: Option): boolean; initialize(): void; dispose(): void; cleanUp(): void;
};
export class CubismMatrix44 { multiplyByMatrix(matrix: CubismMatrix44): void; }
export interface CubismModelMatrix extends CubismMatrix44 { setupFromLayout(layout: Map<string, number>): void; }
export class CubismModelSettingJson {
  constructor(buffer: ArrayBuffer, size: number);
  getModelFileName(): string; getTextureCount(): number; getTextureFileName(index: number): string;
  getLayoutMap(layout: Map<string, number>): void; release(): void;
}
export interface CubismModel {
  getParameterCount(): number;
  getParameterId(index: number): { getString(): string };
  getParameterMinimumValue(index: number): number; getParameterMaximumValue(index: number): number;
  setParameterValueByIndex(index: number, value: number): void;
  saveParameters(): void; loadParameters(): void; update(): void;
}
export interface CubismRenderer {
  startUp(gl: WebGL2RenderingContext): void; setIsPremultipliedAlpha(value: boolean): void;
  bindTexture(index: number, texture: WebGLTexture): void; loadShaders(path: string): void;
  setMvpMatrix(matrix: CubismMatrix44): void;
  setRenderState(framebuffer: WebGLFramebuffer | null, viewport: number[]): void;
  drawModel(path: string): void;
}
export class CubismUserModel {
  loadModel(buffer: ArrayBuffer, checkConsistency: boolean): void;
  getModel(): CubismModel; getModelMatrix(): CubismModelMatrix;
  createRenderer(width: number, height: number): void; getRenderer(): CubismRenderer;
  setRenderTargetSize(width: number, height: number): void; release(): void;
}
export class CubismShaderManager_WebGL {
  static getInstance(): CubismShaderManager_WebGL;
  getShader(gl: WebGL2RenderingContext): { _isShaderLoaded: boolean; codiaLoadError: Error | null };
  releaseGlContext(gl: WebGL2RenderingContext): void;
}
export class CubismWebGLOffscreenManager {
  static getInstance(): CubismWebGLOffscreenManager;
  removeContext(gl: WebGLRenderingContext | WebGL2RenderingContext): void;
  beginFrameProcess(gl: WebGLRenderingContext | WebGL2RenderingContext): void;
  endFrameProcess(gl: WebGLRenderingContext | WebGL2RenderingContext): void;
}
