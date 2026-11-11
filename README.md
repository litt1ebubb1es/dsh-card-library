# 卡片库（dsh-card-library）

一个 [DSH](https://github.com/deepseek-ai/dsh) 插件：右侧栏面板勾选六类卡 → 拼成一份出图配方 → 复制 / 填进输入框。

六类卡不是提示词模板拼盘，而是**按职责拆开的六层**：画风管画法、角色管长相、造型管穿什么、环境管在哪、动作管在做什么、道具管手里拿着什么。每层只能选一张，拼配方时各段各管一段，互不覆盖。

## 内容

| 类 | 数量 | 内容 |
|---|---|---|
| 画风 | 7 | ★柔光半写实（wlop+minaba）/ ★Cygames 明亮插画（lack+redjuice，去 AI 感）/ ★黑白漫画墨线（**img2img 专用**）/ 基准七画师 11+13+35 / 动漫赛璐璐（大眼档）/ 全彩条漫 / NSFW boris |
| 角色 | 2 | 白毛吸血鬼 / 蓝色大肥鱼 |
| 造型 | 47 | **穿什么**（`look_tags`），不含场景、不含动作 |
| 环境 | 140 | 地点 · 天气 · 光线 · 氛围 · 道具 + 相机（**纯环境**，不含动作/服装/表情） |
| 动作 | 316 | 姿势 · 动作 · 表情 · 视线 · 景别（不含服装，服装在造型卡） |
| 道具 | 122 | 手里拿什么 / 身上挂什么（物，不含持有者与场景） |

634 张缩略图（`library/thumbs/`，宽 320）。全部是中文卡名 + 英文 tag，搜索两边都吃。

**六格槽位**：每类只能选一张，点已选的卡取消。六格全选 = 完整配方；只选画风也能出。

### 六类卡的分工（这条是重点）

- **画风卡**只回答「怎么画」（画师段 / 渲染档 / 采样参数 / 后期）
- **角色卡**只回答「长什么样」（body / feature 两段，不含服装）
- **造型卡**只回答「穿什么」（衣服 / 鞋袜 / 配饰）
- **环境卡**只回答「在哪、什么天气、什么光、什么景别」
- **动作卡**只回答「在做什么」（姿势 / 表情 / 视线）
- **道具卡**只回答「手里拿着什么」

动作来源优先级：选了动作卡 → 用动作卡的 `pose_tags`；没选动作卡但勾了「带动作」→ 用造型卡的 `pose_tags`。

## 安装

插件走 DSH 的 bundle patch，两半：`index.js`（宿主，读卡 + 拼配方 + HTTP 路由）、`client.js`（浏览器，右侧栏 UI）。

```bash
git clone https://github.com/litt1ebubb1es/dsh-card-library.git
cd dsh-card-library
```

然后把它链进 DSH profile（以 `~/.dsh/profiles/web` 为例）：

```bash
# 1) 链进 node_modules
MSYS=winsymlinks:nativestrict ln -s /path/to/dsh-card-library ~/.dsh/profiles/web/node_modules/dsh-card-library
#    Windows 用 mklink /D 或 PowerShell 建软链都容易失败，git-bash 的 ln -s 最稳

# 2) profiles/web/package.json 的 dependencies 加一行
#    "dsh-card-library": "link:/path/to/dsh-card-library"

# 3) profiles/web/package.json 的 dsh.profile.bundles 数组里加上 "dsh-card-library"
```

重载：

```
plugin_manager set_plugin(target:"include:card-library-plugin", enabled:false)
plugin_manager set_plugin(target:"include:card-library-plugin", enabled:true)
```

必须用 `include:card-library-plugin`，短名 `card-library-plugin` 会报 `unknown-plugin`。

## 打开

右侧栏 → 「卡片库」标签。没有右侧栏就点右上角的侧栏按钮。

## 用法

1. 点六个 pill 切换类别
2. 搜索框支持中文名、id、主题，**也支持英文 tag**（比如 `hoodie`）
3. 环境 / 动作 / 道具卡有分组 pill（sfw / nsfw / near / pose；配饰 / 食物饮品 / 奇幻魔法 / 家居 / 日常 / 武器 / 电子乐器 / 文具纸品）
4. 点卡片选中，再点一次取消
5. 底部 seed 可空（空 = 随机）
6. 点「生成配方 (n/6)」
7. 配方出来后三选一：
   - **复制配方** → 自己粘到别处
   - **填入输入框** → 直接塞进对话
   - **清空**

## 配方里有什么

- 正向提示词：`quality + 画师 + 角色 + 造型 + 道具 + 场景 + 脸光 + 渲染档`（下划线已转空格、画师带 `@`、按 quality→count→character→artist→general 排序）
- 负面提示词：画风卡 + 角色卡 + 造型卡三处合并
- 参数：`miaomiaoHarem_anima8Step10` / LoRA 0.4 / 12 步 cfg 2.0 euler simple / 832x1216（横构图场景自动切 1216x832）
- 后期：按画风卡的 `post` 字段走 —— ★柔光半写实是 lift_shadows + haze（雾感柔光）；★Cygames 明亮是 lift + glow + crisp + grain（加结构，不加雾）
- **自检提示**：配方顶部会列出这次组合可能打架的地方（远景降级了脸光、背影会吃掉异色瞳、道具 hold 但没勾带动作、动作卡原本在别的场景…）

## 参数优先级

**画风卡最硬**。角色卡和造型卡只补画风卡缺的键，绝不覆盖底模 / steps / cfg。

原因：角色卡里存的是老底模 anima-base 的 45 步 / cfg 4.5，一旦盖过来 8step 模型直接跑废。

## img2img 专用的画风卡

`style_manga_ink_v1`（★黑白漫画墨线）跟别的不一样 —— 它**不能直接 text2img 跑**。

原因：这个底模从零画不出真正的墨线稿（十一轮实测）。正向词堆 `monochrome` + 负面锁彩色 + cfg 抬到 6.0，能压成黑白，但画法是「AI 模仿漫画」——头发是纯黑色块、眼睛是两个空洞黑块、线条粗而均匀像描边贴纸。真正的墨线画法只能靠底图继承。

所以这张卡的 json 里有几个特殊字段：

| 字段 | 作用 |
|---|---|
| `mode: "img2img"` | 标记这张卡必须走 img2img（面板选中它会弹警告） |
| `init_required: true` | 必须给一张 1280×1807 的底图 |
| `init_hint` | 底图怎么来的（任意真漫画页 / 程序画的空白分镜骨架 / 上一轮成品）、画骨架的代码、完整工作流 |
| `colorize` | 第二条用法：把黑白页上色（denoise 0.65-0.75 + cfg 5.0 + 逐区域点名颜色） |

工作流：`LoadImage → VAEEncode → KSampler(denoise=0.85) → VAEDecode → SaveImage`。
**denoise 是唯一要紧的旋钮**：0.80 保原图多 / 0.85 结构稳且内容全新 / 0.92 分镜结构溶解。

后期不要套 haze / bloom / grain —— 那些是柔光画风用的，会把网点糊掉。只用轻微锐化。

## 道具卡的 hold

- `hold: true` —— 通常握在手里，拼配方时自动补 `holding ` 前缀（`prop_umbrella` → `holding umbrella, open umbrella`）
- `hold: false` —— 穿戴 / 摆件（项链、王冠、花瓶），不加动词

多选时握持类会合并成一个 `holding A and B`，最多 4 件。

## 视角

除了六类卡，面板还有 3D 视角选择器（机位 / 视线 / 景别 / 镜像），映射成 `from front` / `from behind` / `looking at viewer` / `looking back` / `full body` 这类方向词。

- 视角优先于环境卡的 `camera`：选了视角，环境段就不再带 `from behind` 和景别词
- 背面机位 + 视线朝机位 → 自动取 `looking back`
- 背面机位 + 背对镜头 → 警告「异色瞳会消失」
- 远景（shot=5）→ 自动降级脸光，改 `ambient light`
- 俯拍 + 低头 → 警告「看不见脸」

## 路由

`/dsh-card-library/{index,card,thumb,image,compose}`

不用 `/api` 前缀 —— 那个前缀被 `@deepseek-ai/dsh-api-gateway` 的 `connection.rpc.intercept("/api", …)` 接管，没有浏览器会话凭证一律 401。本机 curl 自测要带 `-H "host: 127.0.0.1:3080"`。

只接受本机同源请求：Host 必须是 `127.0.0.1` / `localhost` / `[::1]`，Origin 有就比 host+port。

## 卡片库在哪

默认用插件自带的 `library/`（跟着仓库一起分发）。想换成自己的库，设环境变量：

```bash
export CARD_LIBRARY_ROOT=/path/to/your/cards_library
```

没设的话按这个顺序找第一个存在的：

1. `<插件根>/library`
2. 从当前工作目录往上 4 层，每层试 `_assets/cards_library` / `cards_library` / `library`

目录结构：

```
library/
  index.json                 # 索引（含搜索用的 kw 字段、缩略图路径 thumb）
  styles/  characters/  looks/  scenes/  poses/  props/    # 各卡 json
  thumbs/                    # 缩略图，thumbs/<卡 id>.jpg
```

## 加卡

按对应目录的字段结构写 json，然后重建 index（会自动扫目录，不用手改 `index.json`）。字段：

- 画风：`quality_prefix / artist_segment / render / face_light / negative / post / params / thumb / scene_hint`
- 角色：`body_segment / feature_segment / negative / key_traits / common_mistakes / params`
- 造型：`look_tags / pose_tags / fields / body_decor / look_notes / negative_extra / params`
- 环境：`tags{place,weather,light_fx,texture_fx,prop} / camera{shot_size,viewpoint,comp,dof} / extra / extra_camera / env_nl / group / aspect`
- 动作：`pose_tags / pose_nl / camera / suggest_place / env_ref / group / aspect`
- 道具：`prop_tags / prop_nl / hold / suggest_pose / group / aspect`

改完记得顶一次 `index.json` 的 mtime 破缓存（`loadCard` 跟 mtime 走）：

```bash
python -c "import os;os.utime('library/index.json',None)"
```

只改卡片数据不用重载 fiber —— 运行时能直接读到新卡。改了 `index.js` / `client.js` 才需要 `plugin_manager set_plugin` 重载。

## 自测

```bash
node selfcheck.mjs
```

37 项断言：六类 counts、卡片字段、缩略图、越界防护、compose 正/负面、参数优先级、动作卡开关、道具卡、视角映射、外域 Host 403、模型工具输出。不启 DSH，用假 ctx 把路由抓下来打真实请求。

## 模型工具

宿主半端注册了一个工具 `card_library_compose`，参数与 HTTP `/compose` 一致：

```json
{
  "styleId": "style_wlop_warm_soft",
  "characterId": "crab_vampire",
  "lookId": "look_red_hoodie",
  "sceneId": "sc_rain_street_lookback",
  "poseId": "pose_rain_street_lookback",
  "propIds": ["prop_umbrella"],
  "view": { "angle": "front", "gaze": "front", "shot": 2, "flip": false },
  "seed": 884101
}
```

返回正向 / 负面提示词、参数、后期、自检警告。所以模型可以不经浏览器直接拼配方。

## 许可

MIT。卡片内容（中文卡名、提示词段、缩略图）随仓库一起分发。
