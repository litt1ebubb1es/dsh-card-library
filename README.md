# 卡片库（dsh-card-library）

六类卡 + 右侧栏面板：勾选组合 → 生成出图配方 → 复制 / 填进输入框。

## 打开

右侧栏 → 「卡片库」标签。没有右侧栏就点右上角的侧栏按钮。
面板顶部两个页签：**选卡**（拼配方）、**规则 / 体检**（存卡规则清单 + 一键全库体检）。

## 六类卡

| 类 | 数量 | 内容 |
|---|---|---|
| 画风 | 16 | 决定画师、渲染档、脸光与后期。★柔光半写实（wlop+minaba）/ ★Cygames 明亮插画 / ★哥特巴洛克水彩 / ★复古半调套印海报 / ★望月けい赛璐璐 / ★天野喜孝空灵 / ★天野喜孝柔光雾 / ★90s 赛璐璐 / ★淡彩水彩 / ★水墨单色 / ★浮世绘木版 / ★黑白漫画墨线（**img2img 专用**）/ ★全彩条漫 / 基准七画师 / 动漫赛璐璐 / NSFW boris |
| 角色 | 2 | 决定是谁（外貌锁定） |
| 造型 | 50 | **穿什么**（`look_tags`），不含场景、不含动作 |
| 环境 | 140 | 地点 · 天气 · 光线 · 相机（**纯环境**，不含动作/服装/表情） |
| 动作 | 319 | 姿势 · 动作 · 表情 · 视线 · 景别 · 机位 |
| 道具 | 124 | 手里拿什么 / 身上挂什么（物，不含持有者与场景） |

**六格槽位**：每类只能选一张，点已选的卡取消。道具可多选（最多 4 件）。六格全选 = 完整配方；只选画风也能出。

### 六类卡的分工（这条是重点）

- **画风卡**只回答「用什么画法」（画师、渲染、脸光、后期）
- **角色卡**只回答「是谁」（身材 + 基础特征）
- **造型卡**只回答「穿什么」（衣服/鞋袜/配饰）
- **环境卡**只回答「在哪、什么天气、什么光」
- **动作卡**只回答「在做什么」（姿势/表情/视线/景别/机位）
- **道具卡**只回答「手里拿着什么」

动作来源优先级：选了动作卡 → 用动作卡的 `pose_tags`；没选动作卡但勾了「带动作」→ 用造型卡的 `pose_tags`。

## 用法

1. 点六个 pill 切换类别
2. 搜索框支持中文名、id、主题，**也支持英文 tag**（比如 `hoodie`）
3. 环境 / 动作 / 道具卡有分组 pill
4. 点卡片选中，再点一次取消
5. 3D 视角选择器：左键选机位、右键选视线；选了视角就由视角接管景别与机位
6. 底部 seed 可空（空 = 随机）
7. 点「生成配方 (n/6)」
8. 配方出来后三选一：**复制配方** / **填入输入框** / **清空**

## 配方里有什么

- 正向提示词：`quality + 画师 + 角色 + 造型 + 动作景别 + 动作机位 + 道具 + 场景 + 视角 + 脸光 + 渲染档`（按 n55 铁律排序、下划线已转空格、画师带 @）
- 负面提示词：画风卡 + 角色卡 + 造型卡三处合并，再减去与正向重复的词
- 参数：`miaomiaoHarem_anima8Step10` / LoRA 0.4 / 12步 cfg2.0 euler simple / 832x1216（横构图场景自动切 1216x832）
- 后期：按画风卡的 `post` 字段走

### 自动处理的冲突（绿色「已自动处理」块）

配方顶部会先列**已经改掉**的东西 —— 这些情况下配方和卡里的原样不同，必须看见：

| 类 | 什么时候触发 | 怎么处理 |
|---|---|---|
| 裸露 | 正向要 nude / bottomless，但画风卡负面写着 `nude, panties, clothing…` | 从负面里剔掉这些槽位，否则人物莫名穿好衣服 |
| 露肤 | 正向要 cleavage / open shirt / lingerie，但负面锁着 `open shirt, strapless, low cut…` | 剔掉「遮住」类负面，但保留 `nipples, topless, nude` 这些防意外的 |
| 光照 | 场景是夜景 / 霓虹 / 暖光，但负面写着 `night, dark background` / `neon` / `blue tint` | 按场景剔掉自相矛盾的负面 |
| 视线 | 动作卡同时写 `looking at viewer` 和 `looking back` | 按机位裁决：`from behind` 留回头、删看镜头；否则反过来 |
| 景别 | 动作卡要全身、环境卡写 upper body（或反之） | **动作卡说了算**，撤掉环境卡的景别词 |
| 机位 | 动作卡写 `from behind`、环境卡写 `from side`（基础机位互斥） | **动作卡说了算**，撤掉环境卡的机位词 |

优先级一律 **视角 > 动作卡 > 环境卡**。

**特殊机位只提醒不动配方**：`pov / fisheye / dutch angle / bird's eye / worm's eye / over-the-shoulder / foreshortening / panorama / selfie` 这类是「摄影手法」不是「从哪边看」，环境卡的 `bird's eye view` 常常就是场景本身的性质，自动删会毁掉场景 —— 只报 warn，交给人判断。

**注意块（黄色）**：剩下的都是没法机械判断的（远景吃掉异色瞳、背影吃异色瞳、动作卡原本在别的场景、特殊机位冲突…）。

## 参数优先级

**画风卡最硬**。角色卡和造型卡只补画风卡缺的键，绝不覆盖底模/steps/cfg。
原因：角色卡里存的是老底模 anima-base 的 45步/cfg4.5，一旦盖过来 8step 模型直接跑废。

## img2img 专用的画风卡

`style_manga_ink_v1`（★黑白漫画墨线）跟别的画风卡不一样 —— 它**不能直接 text2img 跑**。

原因：这个底模从零画不出真正的墨线稿（十一轮实测）。正向词堆 `monochrome` + 负面锁彩色 + cfg 抬到 6.0，能压成黑白，但画法是「AI 模仿漫画」——头发是纯黑色块、眼睛是两个空洞黑块、线条粗而均匀像描边贴纸。真正的墨线画法只能靠底图继承。

所以这张卡的 json 里有几个特殊字段：

| 字段 | 作用 |
|---|---|
| `mode: "img2img"` | 标记这张卡必须走 img2img（面板选中它会弹警告） |
| `init_required: true` | 必须给一张 1280×1807 的底图 |
| `init_hint` | 底图怎么来的、画骨架的代码、完整工作流 |
| `colorize` | 第二条用法：把黑白页上色（denoise 0.65-0.75 + cfg 5.0 + 逐区域点名颜色） |

工作流：`LoadImage → VAEEncode → KSampler(denoise=0.85) → VAEDecode → SaveImage`。
**denoise 是唯一要紧的旋钮**：0.80 保原图多 / 0.85 结构稳且内容全新 / 0.92 分镜结构溶解。

后期不要套 haze / bloom / grain —— 那些是柔光画风用的，会把网点糊掉。只用轻微锐化。

## 道具卡的 hold

- `hold: true` —— 通常握在手里，拼配方时自动补 `holding ` 前缀
- `hold: false` —— 穿戴 / 摆件（项链、王冠、花瓶），不加动词

多选道具时合并成一个 `holding A and B`（写两遍 holding 模型只画一个）。

## 存卡规则

规则写在 `rules.js` 里，是插件的一部分，不是文档 —— 面板「规则 / 体检」页签读的就是它，模型工具 `card_library_save_rules` 输出的也是它。改规则只改 `rules.js` 一处。

规则分三档：

- **硬性（error）** —— 会挡住入库
- **提醒（warn）** —— 历史数据或需要人判断，不挡
- **只能人工确认（manual）** —— 机器判不了

17 条规则的骨架：

| id | 级 | 管什么 |
|---|---|---|
| `R1_user_pick` | manual | 出完一批图必须等用户报编号才能存，不许批量全存 |
| `R2_boundary` | error | 六类卡职责边界：造型卡不许有 `pose_tags`；环境卡不许有动作词；道具卡不许有持有者；角色卡不许有服装词；画风卡的 render/face_light/scene_hint 不许有动作词（表情族豁免） |
| `R2b_pose_garment` | warn | 动作卡带服装词（`skirt pull` / `panties aside` 这类是动作本身，属历史数据） |
| `R2c_prop_verb` | warn | 道具卡带动作短语（`sitting on cushion` 等 4 张） |
| `R3_id_prefix` | error | id 必须小写蛇形（前缀不强求，历史卡 `nsfw_bathtub_edge` 不报） |
| `R4_tag_format` | error | 画风卡的 `artist_segment` 必须带 `@`（只有它真进配方） |
| `R4b_underscore` | warn | 标签里的下划线（`score_7`/`score_9` 豁免；运行时兜底转空格） |
| `R4c_artist_meta` | warn | 造型卡上的 `artist_segment` 是历史元数据，不进配方 |
| `R5_thumb` | error | 缩略图三层：字段 / 文件 / md5 撞图 |
| `R6_no_scene` | error | 只查真进配方的字段，不查 legacy `tags` 和散文 `*_nl` |
| `R6b_pose_place` | warn | 动作卡 `pose_tags` 里的地点词 |
| `R7_negative_string` | error | `negative_extra` 必须是字符串，且不许逗号粘连 |
| `R8_no_leak` | error | 卡内不许有绝对路径 / 令牌 / 端口 |
| `R9_four_step` | manual | 改完卡跑四连 |
| `R10_legacy_pose` | warn | `tag_split.version ≥ 3` 但缺 `legacy_pose_ref` |
| `R11_preview_local` | warn | `preview` 指向库外（导出模式下报） |
| `R12_color_bound` | warn | 孤立颜色词且造型卡里没有任何服装词 |

### 缩略图模板

| 类 | 画幅 | 模板 |
|---|---|---|
| 画风 / 造型 | 宽 320 | 各自的画风出全身 |
| 环境 | 640×384 | 空镜，无人、无景别词 |
| 动作 | 384×512 | 白底全身，统一白 T + 牛仔短裤 + 运动鞋 |
| 道具 | 512×512 | 白底静物产品图 |

## 库在哪

`_assets/cards_library/`
- `index.json` 索引（含搜索用的 `kw` 字段、缩略图路径 `thumb`）
- `styles/` `characters/` `looks/` `scenes/` `poses/` `props/` 各卡 json
- `thumbs/` 缩略图

改库根：环境变量 `CARD_LIBRARY_ROOT`。

## 加卡

按对应目录的字段结构写 json，然后重建 index（会自动扫目录，不用手改 index.json）。字段：

- 画风：`quality_prefix / artist_segment / render / face_light / negative / post / params / preview / scene_hint`
- 角色：`character_segment / negative / key_traits / common_mistakes / params`
- 造型：`look_tags / pose_tags / fields / body_decor / look_notes / negative_extra / params`
- 环境：`tags{place,weather,light_fx,texture_fx,prop} / camera{shot_size,viewpoint,comp,dof} / extra / extra_camera / env_nl / group / aspect`
- 动作：`pose_tags / pose_nl / camera{shot_size,viewpoint} / suggest_place / env_ref / group / aspect`
- 道具：`prop_tags / prop_nl / hold / suggest_pose / group / aspect`

写完之后先跑体检（面板「规则 / 体检」页签，或模型工具 `card_library_lint`），0 error 才入库。

## 改完卡片必做四步

```bash
python _rebuild_index_v2.py
python -c "import os;os.utime('_assets/cards_library/index.json',None)"   # 顶 mtime 破缓存
cd _dsh_plugin/dsh-card-library && node selfcheck.mjs                      # 应 ALL PASS
```
然后在 dsh 里执行 `plugin_manager set_plugin(target:"include:card-library-plugin", enabled:false)` 再 `true` 重载 fiber。

## 自测

```bash
cd _dsh_plugin/dsh-card-library
node selfcheck.mjs
```

134 项断言：六类 counts、卡片字段、缩略图、越界防护、compose 正/负面、参数优先级、动作卡开关、道具卡、外域 Host 403、脸光归属、景别裁决、机位裁决、存卡规则、全库体检、模型工具输出。

## 路由

`/dsh-card-library/{index,card,thumb,image,compose,rules,lint}`

`/rules` 返回规则清单（含字段白名单与缩略图模板），`/lint` 跑全库体检（`?root=` 可指别处，`?export=1` 进导出模式）。

不用 `/api` 前缀 —— 那个前缀被 `@deepseek-ai/dsh-api-gateway` 的 `connection.rpc.intercept("/api", …)` 接管，没有浏览器会话凭证一律 401。本机 curl 自测要带 `-H "host: 127.0.0.1:3080"`。

## 模型工具

- `card_library_compose` —— 传卡 id 拿完整配方文本
- `card_library_save_rules` —— 读存卡规则（`verbose: true` 附字段白名单与缩略图模板）
- `card_library_lint` —— 跑全库体检，输出 PASS/FAIL + 错误 + 提醒 + 撞图

## 许可

MIT
