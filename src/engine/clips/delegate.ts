/** MediaPipe's GPU delegate needs real graphics hardware. Headless Chromium on a server falls back to a software renderer
 * (SwiftShader, llvmpipe), where the "GPU" delegate still starts but runs through an emulator, many times slower than the
 * CPU delegate itself. */
export function hasGraphicsHardware(): boolean {
  try {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2') as WebGL2RenderingContext | null;
    if (!gl) return false;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return !/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
  } catch { return false; }
}

/** The delegates to try, in order: the GPU only where there is one. */
export const delegatesToTry = (): ('GPU' | 'CPU')[] => hasGraphicsHardware() ? ['GPU', 'CPU'] : ['CPU'];
