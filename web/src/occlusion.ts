import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import type { WebGLRenderer, WebGLRenderTarget } from 'three';

/** Layer 1 contains opaque world surfaces. Windows, sky and navigation marks
 * must not become opaque occluders in the normal/depth prepass. */
export class ArchitectureAO extends GTAOPass {
  override render(renderer: WebGLRenderer, write: WebGLRenderTarget, read: WebGLRenderTarget) {
    const mask = this.camera.layers.mask;
    this.camera.layers.set(1);
    try { super.render(renderer, write, read, 0, false); }
    finally { this.camera.layers.mask = mask; }
  }

  override dispose() {
    super.dispose();
    // Three r182 omits these materials from GTAOPass.dispose().
    this.gtaoMaterial.dispose();
    this.blendMaterial.dispose();
  }
}
