# Plugin GLBModels - Modelos 3D para roBrowserLegacy

## Visao Geral

Este plugin substitui sprites 2D de entidades (mobs, NPCs, guardians, etc.) por modelos 3D no formato **GLB (glTF Binary 2.0)**. Quando o plugin nao esta ativo, o fallback original para sprites continua funcionando normalmente.

Os modelos sao carregados pela API `Client.loadFile`, usando o mesmo pipeline do RemoteClient/GRF que carrega todos os outros assets do jogo.

---

## Estrutura de Pastas (GRF/RemoteClient)

```
data/model/
├── 3dmob/                            # Modelos 3D (mesh + skeleton + animacao idle embutida)
│   ├── empelium90_0.glb              # Emperium - brilhando/pulsando
│   ├── guildflag90_1.glb             # Bandeira de guild - balancando
│   ├── treasurebox_2.glb             # Bau do tesouro - parado
│   ├── kguardian90_7.glb             # Knight Guardian - pose base
│   ├── aguardian90_8.glb             # Archer Guardian - respirando
│   └── sguardian90_9.glb             # Sword Guardian - idle
│
└── 3dmob_bone/                       # Animacoes de acao (skeleton + animacao)
    ├── 1_attack.glb                  # Bandeira - ataque
    ├── 2_damage.glb                  # Bau - dano
    ├── 2_dead.glb                    # Bau - morte
    ├── 7_attack.glb                  # Knight Guardian - ataque
    ├── 7_move.glb                    # Knight Guardian - movimento
    ├── 7_damage.glb                  # Knight Guardian - dano
    ├── 7_dead.glb                    # Knight Guardian - morte
    ├── 8_attack.glb                  # Archer Guardian - ataque
    ├── 8_move.glb                    # Archer Guardian - movimento
    ├── 8_damage.glb                  # Archer Guardian - dano
    ├── 8_dead.glb                    # Archer Guardian - morte
    ├── 9_attack.glb                  # Sword Guardian - ataque
    ├── 9_move.glb                    # Sword Guardian - movimento
    ├── 9_damage.glb                  # Sword Guardian - dano
    └── 9_dead.glb                    # Sword Guardian - morte
```

### Convencao de Nomes

O **mob index** e o elo entre modelo e animacoes:

```
Modelo:    aguardian90_[8].glb        <-- "8" no FINAL = mob index
                        |
Animacoes: [8]_attack.glb             <-- "8" no INICIO = mesmo mob index
           [8]_move.glb
           [8]_damage.glb
           [8]_dead.glb
```

### Tipos de Arquivo

| Tipo | Pasta | Conteudo |
|------|-------|----------|
| **Modelo** | `3dmob/` | Mesh + materiais + texturas + skeleton + animacao idle embutida |
| **Bone Action** | `3dmob_bone/` | Skeleton + uma animacao de acao (attack, move, damage, dead) |

### Mapeamento Completo

| Mob Index | Modelo (3dmob/) | Animacao Embutida | Bone Actions (3dmob_bone/) |
|-----------|-----------------|-------------------|---------------------------|
| 0 | empelium90_0 | Brilhando/pulsando | (nenhuma) |
| 1 | guildflag90_1 | Bandeira balancando | 1_attack |
| 2 | treasurebox_2 | Parado | 2_damage, 2_dead |
| 7 | kguardian90_7 | Pose base/idle | 7_attack, 7_move, 7_damage, 7_dead |
| 8 | aguardian90_8 | Respirando/idle | 8_attack, 8_move, 8_damage, 8_dead |
| 9 | sguardian90_9 | Idle | 9_attack, 9_move, 9_damage, 9_dead |

---

## Como Funciona o Carregamento

```
Entity spawn (job 1285 = Archer Guardian)
  |
  v
GLBModelRegistry -> config: { file: 'aguardian90_8.glb', mobIndex: 8 }
  |
  v
1. Client.loadFile('data/model/3dmob/aguardian90_8.glb')
   -> Mesh + skeleton + idle animation
  |
  v
2. Client.loadFile('data/model/3dmob_bone/8_attack.glb') -> merge "attack"
   Client.loadFile('data/model/3dmob_bone/8_move.glb')   -> merge "move"
   Client.loadFile('data/model/3dmob_bone/8_damage.glb') -> merge "damage"
   Client.loadFile('data/model/3dmob_bone/8_dead.glb')   -> merge "dead"
   (em paralelo, arquivos faltantes sao ignorados)
  |
  v
3. Upload para GPU -> Entity renderiza com modelo 3D
```

---

## Configuracao

### Config.local.js

```javascript
window.ROConfigLocal = {
    // ... outras configs ...
    plugins: {
        GLBModels: {
            path: 'GLBModels/GLBModels',
            pars: {
                modelPath: 'data/model/3dmob/',
                bonePath: 'data/model/3dmob_bone/',
                models: {
                    // Emperium (sem bone actions - so a animacao embutida)
                    1288: { file: 'empelium90_0.glb', mobIndex: 0, scale: 0.20 },

                    // Guild Flag (so attack como bone action)
                    1911: { file: 'guildflag90_1.glb', mobIndex: 1, scale: 0.15,
                            actions: ['attack'] },

                    // Treasure Box (damage + dead)
                    1191: { file: 'treasurebox_2.glb', mobIndex: 2, scale: 0.12,
                            actions: ['damage', 'dead'] },

                    // Knight Guardian (todas as acoes)
                    1287: { file: 'kguardian90_7.glb', mobIndex: 7, scale: 0.20 },

                    // Archer Guardian (todas as acoes)
                    1285: { file: 'aguardian90_8.glb', mobIndex: 8, scale: 0.18 },
                    1286: { file: 'aguardian90_8.glb', mobIndex: 8, scale: 0.18 },

                    // Sword Guardian (todas as acoes)
                    1163: { file: 'sguardian90_9.glb', mobIndex: 9, scale: 0.18 }
                }
            }
        }
    }
};
```

### Parametros do Plugin

| Parametro | Tipo | Default | Descricao |
|-----------|------|---------|-----------|
| `modelPath` | string | `data/model/3dmob/` | Caminho GRF para modelos 3D |
| `bonePath` | string | `data/model/3dmob_bone/` | Caminho GRF para bone actions |
| `models` | object | `{}` | Mapa de `entityJobId` -> config |

### Configuracao por Modelo

| Campo | Tipo | Obrigatorio | Default | Descricao |
|-------|------|-------------|---------|-----------|
| `file` | string | Sim | - | Nome do arquivo GLB em `modelPath` |
| `mobIndex` | number | Nao | auto* | Indice do mob para bone actions |
| `scale` | number | Nao | 0.15 | Escala do modelo no mundo RO |
| `actions` | string[] | Nao | `['attack','move','damage','dead']` | Bone actions para carregar |
| `animMap` | object | Nao | null | Mapeamento customizado de animacoes RO -> clips |

\* `mobIndex` e extraido automaticamente do nome do arquivo (ex: `aguardian90_8.glb` -> 8)

---

## IDs de Referencia - Entidades .gr2

Estas entidades mostram um Poring como fallback no roBrowser porque usam Granny 3D (.gr2):

| Entity Job ID | Nome | Modelo Original | Mob Index |
|---------------|------|-----------------|-----------|
| 1285 | Guardian (Archer) | aguardian90_8.gr2 | 8 |
| 1286 | Guardian | aguardian90_8.gr2 | 8 |
| 1287 | Knight Guardian | kguardian90_7.gr2 | 7 |
| 1288 | Emperium | empelium90_0.gr2 | 0 |
| 1163 | Sword Guardian | sguardian90_9.gr2 | 9 |
| 1191 | Treasure Box | treasurebox_2.gr2 | 2 |
| 1911 | Guild Flag | guildflag90_1.gr2 | 1 |

---

## Especificacoes do Modelo GLB

### Formato

- **Formato**: glTF 2.0 Binary (`.glb`)
- Nao suportado: glTF separado (.gltf + .bin), versao 1.0

### Modelo Principal (3dmob/)

Deve conter:
- Mesh completa (vertices, normais, UVs, indices)
- Materiais e texturas embutidas
- Skeleton/Armature (joints, inverse bind matrices)
- Animacao idle/breath embutida (a unica animacao no arquivo)

### Bone Action (3dmob_bone/)

Deve conter:
- Mesmo skeleton/armature do modelo principal
- Uma unica animacao da acao correspondente
- NAO precisa conter mesh ou texturas

### Bone Actions Disponiveis

| Action | Arquivo | Descricao | Mapeamento RO |
|--------|---------|-----------|---------------|
| `attack` | `{idx}_attack.glb` | Animacao de ataque | ATTACK, ATTACK1, SKILL |
| `move` | `{idx}_move.glb` | Animacao de movimento | WALK |
| `damage` | `{idx}_damage.glb` | Animacao de dano | HURT |
| `dead` | `{idx}_dead.glb` | Animacao de morte | DIE |

A animacao embutida no modelo principal e usada para IDLE (e como fallback geral).

### Sistema de Coordenadas

```
GLB (padrao glTF):       Mundo RO:
    Y (cima)                Y (cima = altitude)
    |                       |
    +--- X (direita)        +--- X (leste)
   /                       /
  Z (frente)              Z (sul)
```

- glTF usa **Y-up, right-handed** (padrao)
- Conversao automatica pelo shader

### Escala

| Scale | Uso |
|-------|-----|
| 0.10 | Pequeno (itens, caixas) |
| 0.15 | Medio (mobs padrao) |
| 0.20 | Grande (bosses, Emperium) |
| 0.30 | Muito grande (MVPs) |

### Texturas

- **Embutidas no GLB** (sem referencias externas)
- Power-of-two recomendado: 256x256, 512x512, 1024x1024
- Formatos: PNG (com alpha), JPEG (sem alpha)

### Materiais

- PBR Metallic-Roughness (baseColorFactor + baseColorTexture)
- `doubleSided: true` suportado
- Idealmente 1 material com atlas de textura

### Skinning

- Max joints: 64
- Weights por vertice: 4 (JOINTS_0 + WEIGHTS_0)
- Inverse Bind Matrices obrigatorias

### Limites Recomendados

| Metrica | Recomendado | Maximo |
|---------|-------------|--------|
| Vertices | < 5.000 | 20.000 |
| Triangulos | < 3.000 | 10.000 |
| Materiais | 1-2 | 4 |
| Joints | < 30 | 64 |
| Textura | 512x512 | 1024x1024 |
| Arquivo GLB | < 1 MB | 5 MB |

---

## Como Criar os GLBs no Blender

### Modelo Principal (para 3dmob/)

1. Modele em escala metrica
2. Crie o skeleton/armature
3. Crie uma Action chamada "idle" (ou "breath")
4. Export: `File > Export > glTF 2.0 (.glb)`
   - Format: **glTF Binary (.glb)**
   - Mesh: Apply Modifiers ON
   - Animation: exportar apenas a idle Action
   - Skinning: ON

### Bone Actions (para 3dmob_bone/)

1. Selecione apenas o **Armature** (mesmo skeleton do modelo)
2. Crie uma Action para a acao (ex: "attack")
3. Export: `File > Export > glTF 2.0 (.glb)`
   - Format: **glTF Binary (.glb)**
   - Include: apenas o Armature
   - Mesh: desligar (nao precisa)
   - Animation: exportar apenas a Action da acao
   - Skinning: ON (joints + inverse bind matrices)
4. Nomeie o arquivo: `{mobIndex}_{action}.glb` (ex: `8_attack.glb`)

### Ferramentas Uteis

- **Validador**: https://gltf-viewer.donmccurdy.com/
- **Otimizador**: `npx @gltf-transform/cli optimize input.glb output.glb`
- **Preview**: https://sandbox.babylonjs.com/

---

## Troubleshooting

### Modelo nao aparece
- Console (F12): erros `[GLBModels]` ou `[GLBCache]`
- Teste URL: `http://127.0.0.1:3338/data/model/3dmob/aguardian90_8.glb`
- Verifique mob ID no `models` do Config.local.js

### Animacao nao funciona
- Verifique se o bone file existe: `http://127.0.0.1:3338/data/model/3dmob_bone/8_attack.glb`
- Console mostra: `[GLBCache] Merged N bone action(s)` quando carrega com sucesso
- Se nao carregou nenhum bone, o modelo usa so a animacao embutida (idle)

### Modelo muito grande/pequeno
- Ajuste `scale` (0.05 a 0.5)
- No Blender: Apply Scale (Ctrl+A)

### Modelo na posicao errada
- Origem deve estar nos pes do modelo
- Blender: `Set Origin > Origin to 3D Cursor` com cursor no chao

---

## Codigo do Plugin

```
src/Plugins/GLBModels/
├── GLBModels.js              # Entry point
├── GLBModelRegistry.js       # Registro mobIndex -> modelo
├── GLBCache.js               # Cache + carregamento via Client.loadFile
├── GLBLoader.js              # Parser GLB + merge de bone actions
├── GLBRenderer.js            # Renderizador WebGL2
├── GLBRenderer.vs            # Vertex shader (skinning)
├── GLBRenderer.fs            # Fragment shader (lighting + fog)
├── GLBSkinning.js            # Calculo de joint matrices
├── GLBAnimationMapper.js     # Mapeamento acoes RO -> clips
├── GLBEntityHook.js          # Hooks no pipeline de entidades
└── README.md                 # Este arquivo
```

---

## Compatibilidade

- **WebGL2**: Obrigatorio
- **Browsers**: Chrome 56+, Firefox 51+, Edge 79+, Safari 15+
- **PACKETVER**: Qualquer
- **RemoteClient**: roBrowserLegacy-RemoteClient-JS (porta 3338)
