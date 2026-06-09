/**
 * Plugins/ESRGANTextures/TextureHook.js
 *
 * Monkey-patches Texture.load to decode PNG / JPEG / BMP ArrayBuffers through a
 * native <img> element.
 *
 * CRITICAL: the hook only takes over when the data is a binary buffer whose
 * magic bytes match a supported image format. Every other case (TGA buffers,
 * GIF, string URLs, missing data, ...) is delegated to the original loader, so
 * this can never break the existing texture pipeline.
 */
import Texture from 'Utils/Texture.js';

var TextureHook = {};

/**
 * @var {boolean} guard against multiple installations
 */
var _installed = false;

/**
 * Install the Texture.load hook.
 */
TextureHook.install = function install() {
	if (_installed) {
		console.warn('[ESRGANTextures] Hook already installed, skipping duplicate install');
		return;
	}
	_installed = true;

	var _originalLoad = Texture.load;

	Texture.load = function load(data, oncomplete) {
		// Only intercept raw binary buffers; everything else -> original loader.
		if (data instanceof ArrayBuffer && data.byteLength >= 3) {
			var header = new Uint8Array(data, 0, Math.min(8, data.byteLength));

			// PNG magic:  89 50 4E 47
			var isPNG  = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47;
			// JPEG magic: FF D8 FF
			var isJPEG = header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF;
			// BMP magic:  42 4D
			var isBMP  = header[0] === 0x42 && header[1] === 0x4D;

			if (isPNG || isJPEG || isBMP) {
				// Server returned a standard image format (e.g. upscaled PNG from
				// the ESRGAN cache). Load via an Image element which handles
				// PNG/JPEG/BMP natively, then mirror the core canvas pipeline.
				var args = Array.prototype.slice.call(arguments, 2);
				var mimeType = isPNG ? 'image/png' : isJPEG ? 'image/jpeg' : 'image/bmp';
				var blob = new Blob([data], { type: mimeType });
				var blobUrl = URL.createObjectURL(blob);
				var img = new Image();
				img.decoding = 'async';
				img.src = blobUrl;
				img.onload = function () {
					URL.revokeObjectURL(blobUrl);
					var canvas = document.createElement('canvas');
					var ctx = canvas.getContext('2d', { willReadFrequently: true });
					canvas.width = this.width;
					canvas.height = this.height;
					ctx.drawImage(this, 0, 0, this.width, this.height);
					Texture.removeMagenta(canvas);
					args.unshift(true);
					oncomplete.apply(canvas, args);
				};
				img.onerror = function () {
					URL.revokeObjectURL(blobUrl);
					args.unshift(false);
					oncomplete.apply(null, args);
				};
				return;
			}
		}

		// Default behaviour: TGA buffers, GIF, string URLs, missing data, ...
		return _originalLoad.apply(this, arguments);
	};

	console.log('%c[ESRGANTextures] Texture.load hook installed', 'color: #4CAF50');
};

export default TextureHook;
