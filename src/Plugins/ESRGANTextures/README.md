# Plugin ESRGANTextures - Texturas PNG/JPEG/BMP para roBrowserLegacy

## Visão Geral

O carregador de texturas do core (`src/Utils/Texture.js`) trata **todo**
`ArrayBuffer` binário como **TGA**. Quando o RemoteClient/GRF devolve uma imagem
em formato padrão — por exemplo um **PNG gerado pelo cache do Real-ESRGAN**
(upscaling de textura por IA) — o parser TGA falha e a textura aparece quebrada
ou em magenta.

Este plugin faz **monkey-patch** em `Texture.load`: quando os primeiros bytes do
buffer correspondem ao *magic number* de PNG, JPEG ou BMP, a imagem é decodificada
por um elemento `<img>` nativo e desenhada em canvas (mesmo pipeline do core,
incluindo `removeMagenta`). Qualquer outro caso (TGA, GIF, URL em string, dado
ausente) cai no carregador original — então **o comportamento padrão é preservado**
e o `Texture.js` do core **não precisa ser modificado**.

---

## Como Funciona

```
Texture.load(data, oncomplete)
  |
  v
data é ArrayBuffer com magic bytes PNG/JPEG/BMP?
  |                                   |
  | sim                               | não
  v                                   v
<img> -> canvas -> removeMagenta      Texture.load original (TGA, GIF, URL, ...)
  -> oncomplete(true, canvas)
```

### Magic bytes detectados

| Formato | Bytes iniciais |
|---------|----------------|
| PNG     | `89 50 4E 47`  |
| JPEG    | `FF D8 FF`     |
| BMP     | `42 4D`        |

---

## Configuração

### Config.local.js

```javascript
window.ROConfigLocal = {
	// ...
	plugins: {
		ESRGANTextures: {
			path: 'ESRGANTextures/ESRGANTextures'
		}
	}
};
```

O plugin **não recebe parâmetros**.

---

## Instalação no roBrowserLegacy

Os plugins moram neste repositório (`roBrowserLegacy-plugins`). Para o app
carregá-los, a pasta do plugin também precisa existir em
`roBrowserLegacy/src/Plugins/` (que é gitignorado no repo do app — `/src/Plugins/*/`).

```
roBrowserLegacy-plugins/src/Plugins/ESRGANTextures/   <- fonte versionada
roBrowserLegacy/src/Plugins/ESRGANTextures/           <- cópia que o Vite carrega
```

---

## Código do Plugin

```
src/Plugins/ESRGANTextures/
├── ESRGANTextures.js   # Entry point: instala o hook
├── TextureHook.js      # Monkey-patch de Texture.load (detecção por magic bytes)
└── README.md           # Este arquivo
```

---

## Compatibilidade

- **PACKETVER**: Qualquer
- **RemoteClient**: serve as texturas upscaled como PNG (ex.: cache Real-ESRGAN)
- Sem dependências externas; usa apenas `Blob`, `URL.createObjectURL` e `<img>`
