/**
 * Plugins/ESRGANTextures/ESRGANTextures.js
 *
 * Plugin entry point for loading standard image formats (PNG / JPEG / BMP) as
 * textures.
 *
 * roBrowser's core Utils/Texture.js treats every binary ArrayBuffer as TGA.
 * When the RemoteClient/GRF serves an upscaled image (for example a PNG produced
 * by the Real-ESRGAN texture cache) the TGA parser fails and the texture renders
 * broken / magenta.
 *
 * This plugin hooks Texture.load and, when the binary data starts with a known
 * image magic number (PNG / JPEG / BMP), decodes it through a native <img>
 * element instead of the TGA parser. Anything else falls through to the original
 * loader unchanged, so the default behaviour is preserved when the plugin is not
 * loaded. This keeps src/Utils/Texture.js pristine (no core modification needed).
 *
 * Configuration in Config.local.js:
 *
 *   plugins: {
 *       ESRGANTextures: {
 *           path: 'ESRGANTextures/ESRGANTextures'
 *       }
 *   }
 *
 * The plugin takes no parameters.
 */
import TextureHook from './TextureHook.js';

/**
 * Plugin initialization function.
 * Called by PluginManager with the 'pars' object from config (unused here).
 *
 * @param {object} params - plugin parameters (none required)
 * @returns {boolean} true if initialization succeeded
 */
export default function ESRGANTexturesPlugin(params) {
	try {
		TextureHook.install();

		console.log('%c[ESRGANTextures] Plugin initialized successfully', 'color: #4CAF50; font-weight: bold');
		return true;
	} catch (e) {
		console.error('[ESRGANTextures] Plugin initialization failed:', e);
		return false;
	}
}
