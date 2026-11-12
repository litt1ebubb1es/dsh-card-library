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
| 头出画 | 动作卡显式写 `head out of frame`（腿特写 / 臀特写那一族） | **整段清空脸光** —— `catchlight in both eyes` 是在要求画眼睛，画面里没头时模型只能硬塞一个头进来 |
| 对焦脸 | 上一条成立，同时环境卡的 `camera.dof` 写着 `focus on face` | **撤掉这条对焦** —— 它和脸光同族，都是在要求「把焦点落在脸上」，同样只能靠塞一个头来满足 |
| 道具重名 | 穿戴类道具（`hold=false`）的主名词，造型卡的 `look_tags` 里已经有了 | **撤掉道具那一份** —— 同一件东西进正向两三次，模型不会画成两顶帽子，而是把它当成更强的指令（帽子被放大、颜色被推艳） |
| 道具重复 id | 同一个 `propId` 被传了两次（面板 toggle 不会，但 API / 模型工具 / 手写脚本会） | **按一件处理** —— 否则拼出 `holding uchiwa and uchiwa`，三件时更荒谬，还会误报「手里同时拿了 3 件东西」 |
| 道具泛名 | 道具卡写着更具体的名词（`prop_mask_oni` 的 `mask, fox mask, kitsune mask`、`prop_cake` 的 `cake, … , strawberry shortcake`），老逻辑只取第一个 | **取最具体的那个名词** —— 否则狐面退化成普通面具、草莓蛋糕退化成一块蛋糕；顺带解决 `prop_mask` + `prop_mask_oni` 同时选中时拼出 `holding mask and mask` |
| 画幅 | 动作卡声明 `landscape`（`all fours` / `cowgirl position` 这类横向体位，全库 74 张），没配环境卡 | **按动作卡给 1216x832** —— 早先只有环境卡的 `aspect` 被读过，这些姿势被硬塞进竖画布，两侧直接裁掉 |
| 画法 | 角色卡 / 造型卡的负面里写着画风卡自己主张的画法词（`cel shading` / `flat colors` / `painterly` …） | **从角色 / 造型 / 视角那一段剔掉** —— 19 张造型卡共用一段「柔光半写实」样板负面，换赛璐璐 / 平涂 / 水彩画风卡时等于一边要一边不要。画风卡自己那份负面一个字都不动（`style_anime_cel` 主张赛璐璐、负面却也压 `cel shading` 防糊成一片，是刻意取舍），所以 autofix 文案会写明「还留着 XX —— 那是它刻意的取舍」 |
| 构图槽画幅词 | 环境卡的 `camera.comp` 里写着 `portrait` / `landscape`（15 张：`sc_near_face_classroom` / `sc_rooftop_stretch` / `sc_sock_home_sofa` + 12 张 `sc_wide_*`） | **不把它当构图词用** —— 画幅归「画幅裁决」管（`aspect` → `resolution`）；留在正向里 `portrait` 会被读成「特写」档，和动作卡的景别（如 `cowboy shot`）同时生效，模型两边都听 |
| 闭眼 | 动作卡写 `closed eyes` / `sleeping`（全库 13 张），正向却带着 `heterochromia` / `symbol-shaped pupils` / `blue eyes` / `red eyes` / `catchlight in both eyes` | **撤掉眼睛专属词**（角色段、脸光、render 三处一起剥）—— 闭着眼画不出异色瞳和瞳孔高光，留着只会把脸拽回正面、逼角色睁眼 |
| 闭眼 × 视角 | 动作卡写闭眼 / 睡着，同时又选了视角（`gaze` 会拼出 `looking at viewer, eye contact` 或 `looking back`） | **撤掉视角段的视线词** —— 闭着眼做不到「看镜头 / 回头」，模型唯一的满足方式是把眼睛睁开，于是 v13 剥掉的眼睛词又从这条缝漏回来 |
| 空白背景 | 选了环境卡（140 张全部带 `place`），画风卡的 `render` 却写着 `simple background` / `white background` / `empty background` / `pale gradient background`（6 张） | **从 render 段撤掉空白背景词** —— 场景段要森林/街道、渲染段同时要求白底，等于一边要背景一边不要 |
| 地点 | 画风卡 `render` 里写死一个具体地点（`style_retro90_cel` 的 `city street` / `telephone pole`），和环境卡的 `place` 对不上（130 张非街景环境卡） | **撤掉 render 段的地点词** —— 两段各说一个地方，模型会挑一个或画出拼接背景（海滩上长出一条城市天际线） |
| 景深 | 动作卡的 `camera.dof` 写着 `deep focus`，环境卡的 `camera.dof` 写着 `depth of field, blurry background`（3 张 × 5 张） | **按动作卡取，撤掉环境卡那份** —— 背景不能既糊又清晰。早先动作卡的 `dof` 一个词都没进过正向（23 张全丢），只有环境卡说了算 |
| 构图 | 动作卡的 `camera.comp` 写着 `negative space` / `symmetry` / `profile`（16 张），从没进过正向 | **补进正向** —— 这不是冲突，是被丢弃的声明；里面的画幅词（`landscape` / `portrait`）不进正向，归画幅裁决 |
| 参数元数据 | 卡里的 `params` 混着非采样键：`safe_composition`（"sitting, upper body, cowboy shot" 一句提示词）、`denoise_note` / `note`（中文说明）、`seed`（23 张造型卡各绑一个固定值） | **只搬采样键**，其余剔掉 —— 下游按「键=值」喂采样器会被中文长句噎住；`params.seed` 与顶层 `seed` 还会说两套话（前者钉死 650000，后者 null 交给调用方随机） |
| 人数 | 动作卡是双人 / 群体（count_lock 写着 2girls / 1boy, hetero / group sex，35 张），但正向只有角色段的 1girl, solo，负面还压着 2girls / multiple girls / male | **count_lock 进正向 + 角色段 solo 剥掉 + 负面压多人剔掉** —— 三条一起改，缺一条就画不出第二个人：count_lock 从没进过配方（459 张卡声明过），角色段三处都钉着 1girl, solo，23 张造型卡 + 15 张画风卡的负面本意是「别画成多人」 |
| 脚上穿不穿 | 动作卡写 `bare feet` / `barefoot`（25 张，`pose_beach_midsummer` / `pose_poolside_summer` / `pose_ccc_cowgirl` …），造型卡却配了具体鞋款（34 张：`leather boots` / `mary janes` / `pointe shoes` …） | **撤掉造型卡的鞋** —— 脚上要么穿要么不穿，两句话都在正向里模型只能二选一，实测给赤脚画出一双棕色系带靴（19 张赤足动作卡 × 34 张带鞋造型卡 = 646 组） |
| 整套装束 | 动作卡的 `pose_tags` 里残留整套装束词（`nurse` / `maid` / `serafuku` / `office lady` / `miko` / `yukata` …，17 张：`pose_nurse_rounds` / `pose_maid_serving` / `pose_jk_bike_ride` / `pose_ol_overtime` …），造型卡已经穿了另一套（17 张：`look_military` / `look_qipao` / `look_maid` / `look_nurse` …） | **撤掉动作卡里的装束 token** —— 两套衣服同时进正向会糊在一起：实测军装外面长出白色荷叶边围裙、水手服领子长在旗袍上（17 × 17 交叉 289 组，跨族 248 组） |
| 防护词 | 造型卡正向的 `look_tags` 里钉着「穿好衣服」的防护词（`fully clothed` / `wearing clothes` / `covered chest` / `covered torso`，4 张奇幻造型卡：`look_bell_watcher` / `look_elven_priestess` / `look_night_reader` / `look_tomb_raider`），动作卡却要裸（`completely nude` / `topless` / `cleavage` / `shirt lift` …） | **撤掉造型卡的防护词** —— v5 只在【负面】里剔裸词，这 4 张把防护写在了【正向】，两边互不相干，模型只能在「穿」和「不穿」之间瞎猜（368 组） |
| 道具负面 | 造型卡 / 画风卡的负面里钉着「别在手里多出东西」的黑名单（19 张造型卡的 `holding cup` / `holding book` / `holding bag`，`style_wlop_warm_soft` 的 `beer` / `cigarette`），而用户明确选了那件道具 | **剔掉「压的正是这件」的那几条** —— 正向是 `holding ceramic cup`、负面是 `holding cup`，`minusPositive` 只做整串子串包含，剔不掉（v17 把主名词升级成更具体之后这条缝更宽了） |
| 道具计数 | 选了 5 件以上道具、或造型卡已经穿了同一件（该道具被撤） | **冲突检查只看真正进配方的道具** —— 早先按「全集」算，被撤掉的道具还在参与「同部位叠」检查，报出「贝雷帽和王冠都占头部饰品」这种正向里根本没有贝雷帽的假警告；超上限时也会点名被丢掉的是哪一件 |
| 手持短语 | 动作卡 `pose_tags` 里自带 `holding clipboard` / `holding camera`，用户又选了手持道具 → 撤掉动作卡那份占手短语（否则正向里两套「手里拿什么」，模型丢掉其中一件） |

优先级一律 **视角 > 动作卡 > 环境卡**。

**特殊机位只提醒不动配方**：`pov / fisheye / dutch angle / bird's eye / worm's eye / over-the-shoulder / foreshortening / panorama / selfie` 这类是「摄影手法」不是「从哪边看」，环境卡的 `bird's eye view` 常常就是场景本身的性质，自动删会毁掉场景 —— 只报 warn，交给人判断。

**头出画那条只认显式声明**：光有 `legs focus` / `lower body` / `ass focus` 不算 —— 那些是「拍腿但头可能入画」的中景，脸光必须留着。而且它只**减弱**不禁止：构图本身极近时模型仍会自己补一张脸，要绝对不露脸得改动作卡。

**对焦脸只丢那一档 dof**：`depth of field, blurry background` / `deep focus` 跟脸没关系，头出画时照样保留 —— 只有 `focus on face` 这一类要撤。

**道具重名按词边界比，不是整串相等**：造型卡写 `flower crown`、道具写 `crown`，也要判成重复。反过来 `earring` 不会被 `ring` 命中（前面是字母不是空格）—— 部位槽正则必须两边都有 `\b`，早先 `ring\b` 少了个左边界，把 `wear·ing` 里的 ring 当成戒指，124 张道具里 33 张被误判成「手部饰品」。

**道具泛名只升不降，动词短语一律挡下**：主名词取「以第一个名词结尾、比它长、且不以动词/介词开头」的最长 token —— `red apple` ✓、`kitsune mask` ✓，而 `candlelight` 不以 `candle` 结尾 ✗、`looking through camera` / `standing on skateboard` / `eating doughnut` 是动作短语 ✗。全库 81 张手持卡里 30 张会变具体、9 张被动词规则挡下，提议后主名词全部唯一。**重复 id 去重是防 API 调用方的**：面板 toggle 不会产生重复，但模型工具和手写脚本会，所以去重必须放在读取 `propIds` 的第一步，而不是信面板。

**人数只由动作卡说话，环境卡的人数不算**：环境卡的 `count_lock` 是「成对生成」留下的溯源元数据（140 张里 18 张多人），不是用户意图 —— 让它定人数会把单人动作卡画成双人。动作卡什么都没说时按单人算（角色段本来就钉着 `1girl, solo`）。两边都声明了具体档位且不同时，按动作卡取、只报 warn，不动配方（换掉场景的人数设定会毁构图）。

**人数让位只动人数档**：单人档（全库绝大多数）一个字都不改 —— 角色段照留 `1girl, solo`，负面照压 `2girls`（那是「别画成多人」的正确意图）。画风卡负面这次也一起剔：人数不像画法，画风卡对「画几个人」没有主张权。

**脚上穿不穿分两档，因为「脚是不是画面主体」决定删错的代价**：脚不是主体时（19 张，`bare feet` 只是顺带一句）撤掉造型卡的鞋 —— 鞋在这些构图里只是边角，撤掉不伤画面，留着反而让模型在赤脚上画出一双靴子；脚是主体时（`pose_near_foot_bare` / `pose_near_nsfw_soles`，带 `feet focus` + `head out of frame`）**只 warn 不动配方** —— 穿鞋的脚部特写也成立，撤错整张图就废。反向也管：造型卡赤足 × 动作卡带鞋（12 组，`pose_sock_*` 那一族）撤造型卡的赤足，动作卡点名的鞋更具体。

**整套装束让位只撤「装束 token」，同一条里的其他词一个字不动**：`pose_nurse_rounds` 的 `leg up, embarrassed, blush, nurse, white thighhighs` 只撤 `nurse`，`leg up` / `embarrassed` / `blush` / `white thighhighs` 全留（`white thighhighs` 不是装束族，是腿袜）。原文留在 `segments.action_raw` 里给面板与调试用，`segments.action` 是剥过的版本。

**防护词让位只撤防护词，衣服本体一个字不动**：`look_tomb_raider` 的 `hooded cloak, multiple belts, fingerless gloves, thigh boots, dagger, armored bodysuit` 全部保留，只撤 `fully clothed / wearing clothes / covered chest / covered torso`。半脱、敞开、露肩、开衩都还要靠这些衣服画出来 —— 把衣服一起撤了，画面会变成「什么都没穿站在床上」，而不是「护甲半脱」。

**全裸时四个槽位一起撤，只露一处时只撤那一档**：动作卡写 `completely nude` / `nude with accessories only` / `see-through` 时，四个槽（胸部 / 腰腹 / 下体 / 全身）全部生效 —— 否则会出现「`fully clothed` 撤了、`covered chest` 却还留着」这种半吊子结果（实测第一版就是这样）。只露胸（`cleavage` / `topless` / `open shirt`）时只撤胸部那一档，`covered torso` 该留着；只露肩（`off shoulder`）连胸部档都不触发。
**手持物让位只剔「压的正是用户选的这件」的那几条**：选了 `prop_goldfish_bag`，`holding bag` / `bag` 被剔掉；`holding phone` / `holding book` 这类没选的黑名单原样保留，仍在防「手里多出一只手」。复合词后缀按**空格**判定 —— `goldfish bag` 命中 `bag`，`handbag` 不命中（放开会误伤 `cocktail→tail`、`dice→ice`、`microphone→phone`）；`leather handbag` 配 `holding bag` 属于这条边界之外，属刻意保留。穿戴类道具（`hold=false`）不进名单，不触发。

**道具冲突检查按「生效集」算，不是按「你选了什么」算**：真正进配方的是「前 4 件里、没有被造型卡撤掉的那些」。
`look_painter`（自带贝雷帽）+ `prop_beret`（被撤）+ `prop_crown` 只报一次 `propdup`，
不再报「贝雷帽和王冠都占头部饰品」—— 正向里根本没有贝雷帽。「手里同时拿了 N 件」同理，
按实际件数算。超上限的警告会点名被丢掉的是哪一件（`提灯`），不再只说「选了 5 件」。

**手持短语只撤「占手」的那一份，手的位置词一个字不动**

动作卡的 `pose_tags` 里本来就写着「手里拿什么」（`pose_nurse` 的 `holding clipboard`、
`pose_photographer` 的 `holding camera`、`pose_from_summer_festival` 的 `holding fan` +
`other hand holding goldfish bag`）。用户又选了手持道具时，正向里就有两套「手里拿什么」，
模型只会挑一件 —— cfg 2.0 下常常把道具整个丢掉，cfg 4.5 下变成两手各拿一件。

撤的判据是 `HOLD_PHRASE_RE = /\b(?:holding|carrying)\s+(?!hands?\b|own\b|her\b|his\b|up\b|down\b|back\b)\S/i`：

- `holding` **不必在词首** —— `other hand holding goldfish bag` 也算占手（漏了这条就只撤一半）。
- 撤：`holding clipboard` / `holding camera` / `carrying tray`。
- 不撤：`holding hands`（牵手，双人动作不是道具）、`holding own leg` / `hands on own skirt`
  （身体与衣物）、`both hands on camera` / `camera to eye`（手的位置，不是拿东西）。
- `wearing X` 一律不动 —— 那是「道具重名」与「整套装束」的地盘。
- **没选手持道具时一个字不动**；只选穿戴类道具（`hold=false`）也不触发。

影响面：动作卡自带占手短语 32 张 × 手持道具 81 件 = 2592 组组合，其中同名重叠 17 组
（动作拿的正是你选的那件，正向里会出现 `holding book` + `holding open book` 两处）。



**造型卡自己同时写防护与露肤时不动**：那是卡内自相矛盾（`covered chest` 和 `cleavage` 在同一张卡里），不是跨卡冲突，插件不替你决定；只有「造型卡要捂 + 动作卡要露」这一种跨卡情形才撤。

**同族也撤**：`pose_pose_shrine_kneel` 的 `miko` × `look_summer_festival` 的 `yukata` —— 两个都属「和服」族，仍然撤动作卡那份、留浴衣。理由是造型卡才是「穿什么」的权威（DESIGN_v4 的六类卡职责），动作卡管的是姿势，它顺手写下的装束只是当初出图时的背景板。

**造型卡没有任何装束族时一律保留**（33 张，如 `look_alchemist` / `look_kaftan_red`）：那时动作卡的装束是唯一线索 —— 护士动作配冒险者会真画出护士装，用户可能就要这个效果，自动删掉等于擅自决定了衣服。

**鞋词表必须排除 `sitting on heels`**（跪坐坐在脚跟上）—— `heels` 在这里是身体部位不是鞋，同 n102 的 `ring\b` 把 `wear·ing` 当成戒指那个坑。

**画幅冲突是唯一一个不动配方的画幅情况**：环境卡说横、动作卡说竖（或反之）时，**按环境卡取**并只报 warn —— 换画布会毁掉环境构图，跟特殊机位同一档处理。另外 img2img 专用画风卡的分辨率（`1280x1807`，保住分镜框用）是硬约束，不参与画幅裁决。

**环境卡的构图槽只滤画幅词，构图词一个字不动**：`camera.comp` 这个槽在卡库里混着两种东西 —— 真正的构图词（`negative space` / `symmetry` / `profile`）和画幅声明（`portrait` / `landscape`）。画幅归「画幅裁决」管，不该以构图词的身份进正向；更糟的是 `portrait` 在景别词表里是「特写」档，混进 comp 槽后会和动作卡的景别在正向里并存（15 张环境卡 × 238 张有景别的动作卡 = 3570 组）。所以只滤这两个词，`negative space` / `symmetry` / `profile` 照旧进正向。
配套的 warn 文案要报「实际取哪个画幅」，而这个值必须读 `aspectFix` 的结果 —— 不能拿 comp 槽里的词去推：环境卡 `aspect="both"` 时画幅由动作卡决定，按 comp 槽猜会给出自相矛盾的提示（说走 832x1216、实际 1216x832）。

**画法让位只剔「画风卡自己主张的那一族」**：八族是赛璐璐 / 平涂 / 厚涂 / 线稿 / 水彩 / 半调 / 版画 / 渐变。`style_shadowverse_crisp` 正向写 `cel shading`、负面却压 `flat colors` —— 意思是「要赛璐璐分色、但不要平涂」，这是它刻意的取舍，动了就把画风改掉了，所以**画风卡自己的负面一个字都不动**。清的只是角色卡 / 造型卡 / 视角那一串：`crab_vampire` 的 negative 也带着 `cel shading, flat colors, painterly`，19 张造型卡只是复制了同一段样板。

**闭眼让位只认全闭**：`half-closed eyes` / `eyes half closed` 眼睛还露着、虹膜看得见，异色瞳照样成立，动了反而丢信息 —— 那一档故意不管。剥的只有 `eyes / pupils / irises / catchlight / lashes / heterochromia`，**光照与画法一律保留**（`candle light`、`half of face in shadow`、`halftone dots` 全留着）。

**「只认全闭」必须在正则层面落实，不能只写在注释里**：`half-closed eyes` 里含 `closed eyes` 子串，而 `\b` 在连字符后照样成立 —— 直接 `test()` 会把 11 张半闭眼卡全判成全闭，异色瞳当场被剥掉。同一族的第二个坑是 `sleeping`：`sleeping kimono`（睡袍）、`sleeping bag`（睡袋）都不是在睡觉，裸词匹配会把睡袍卡也剥了。现在的做法是**先剔掉这两族再判**，`one eye closed`（眨眼，另一只还睁着）也归半闭。全库实测：旧正则判 24 张闭眼，新正则判 12 张 —— 一半是误判。

**眼周特征不是「眼睛专属词」**：`EYE_TOKEN_RE` 的 `eyes?` 是子串命中，会把 `mole under eye`（眼下泪痣）与 `close-set eyes`（瞳距）一起吃掉。但痣长在眼睛下方、眼距是颅骨结构 —— 闭不闭眼都在，而这两项正是 `crab_vampire` 的招牌特征（瞳距还是 n5 专门定的）。所以 `stripEyeTokens` 里先过一道 `EYE_AREA_FEATURE_RE` 豁免眼周特征（泪痣 / 眼距 / 眼线 / 眼罩 / 眉毛），再判眼睛本体；`EYE_TOKEN_RE` 本身不动（它还被「头出画」等分支共用）。
影响面只有 `crab_vampire` 一张角色卡（6 处 / 2 种词），但它是默认角色，等于每次闭眼出图都丢。

**闭眼 × 视角是两条不同的缝**：v13 剥的是「卡里的眼睛词」（角色段 / 脸光 / render），v20 剥的是「视角选择器拼出来的视线词」。后者改卡改不掉 —— 它来自面板上的视角选择器，用户看不出问题出在哪。所以单独报一条 `gaze` autofix。**只剥视线，机位（`from front`）与景别（`close-up`）一个字不动**：睡着的人也可以从正面拍、也可以是大特写。

**场景让位只删「字面空白」一族**：`white / simple / plain / empty / solid / blank / pale background`、`pale pink background`、`pale gradient background`。**`negative space` 一个字不动** —— 那是构图留白，是天野喜孝 / 水墨那档的命根子，跟「背景是什么」无关。另外**没选环境卡时一律不动**：那时候画风卡写白底是对的（缩略图、卡牌展示都靠它），只有环境卡的 `tags.place` 非空才算「要背景」。

**景深只有「虚化 vs 深焦」互斥**：`depth of field` / `blurry background` / `bokeh` 要背景糊，`deep focus` 要背景清，这两族不能共存；`focus on face` 与两者都不冲突 ——「对焦在脸 + 背景虚化」是标准电影语法，它只受「头不在画框里」管（v9 同族）。所以景深冲突只在 3 张 `deep focus` 动作卡 × 5 张 `blurry background` 环境卡这 15 组里触发，其余两边共存、交给 `joinSeg` 去重。

**构图（comp）不是冲突，是被丢弃的声明**：动作卡的 `camera.comp` 32 张里 16 个是构图词（`negative space` / `symmetry` / `profile`），补进正向；另 16 个是画幅词（`landscape` / `portrait`），**不进正向** —— 那是 `aspect` 的重复声明，归画幅裁决管。

**地点让位只撤「地点词」，其余三档一律不动**：`detailed background` 是**密度词**不是地点（墨线卡靠它保住信息量，撤了画面变空）、`evening` / `dark background` / `candle light` 是**时间与光**（在卧室并不矛盾）、**没选环境卡时也不撤**（那时画风卡自带的街景设定是对的）。判定按**同族表**走：`telephone pole` / `power line` 属街景构件，配 `street` / `alley` / `crosswalk` / `bridge` / `rooftop` 都算匹配，不会被误撤 —— 早先只做双向子串包含，街景环境卡配 retro90 时电线杆被当成「另一个地点」撤掉了。

**参数只搬采样键**：`model` / `lora` / `clip` / `vae` / `steps` / `cfg` / `sampler` / `scheduler` / `resolution` / `denoise`。卡里的 `params` 还混着 `safe_composition`（一句提示词）、`denoise_note` / `note`（中文说明）、`seed` —— 这些一律不进采样参数。`seed` 统一由顶层 `seed` 管：**卡里的 `params.seed` 不进配方**，否则同一张造型卡永远出同一张图（实测三张逐像素一致，平均差 0.000；而顶层 seed 每次不同的那组平均差 42.87）。

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

380 项断言（含道具计数按生效集、手持短语让位）：六类 counts、卡片字段、缩略图、越界防护、compose 正/负面、参数优先级、动作卡开关、道具卡、外域 Host 403、脸光归属、景别裁决、机位裁决、头出画清脸光、对焦脸让位、道具重名去重、画幅裁决、画法让位、景深裁决、构图补全、人数裁决、防护词让位、手持物让位、闭眼让位、闭眼×视角视线、半闭眼与睡袍误判、眼周特征豁免、脚上穿不穿、整套装束、场景让位、地点让位、参数元数据、道具泛名、道具 id 去重、存卡规则、全库体检、模型工具输出。

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
