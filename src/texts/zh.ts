import type { Language } from './index.ts';

// Simplified Chinese (#166). A key missing here shows the English text.
export const zh: Language = {
  code: 'zh',
  name: '简体中文',
  texts: {
    'chat.viewTitle': '与笔记对话',
    'chat.badge': '本地',
    'chat.header.save': '把对话保存为笔记',
    'chat.header.new': '新对话',
    'chat.header.history': '对话历史',

    'chat.scope.note.label': '当前笔记',
    'chat.scope.note.desc': '只读你打开的这篇笔记',
    'chat.scope.note.title': '问这篇笔记',
    'chat.scope.vault.label': '仓库',
    'chat.scope.vault.desc': '仓库里的任何笔记，或任何一般问题',
    'chat.scope.vault.title': '随便问',
    'chat.scope.wiki.label': 'Wiki',
    'chat.scope.wiki.desc': '{wiki}/ 里的卡片，以及它们之间的联系',
    'chat.scope.wiki.title': '问 {wiki}/ 里的卡片',
    'chat.scope.heading': '回答依据',
    'chat.scope.caption': '随时可以用输入框下方的 {b} 切换。',
    'chat.scope.buttonLabel': '回答依据：{mode}。切换',
    'chat.scope.buttonTip': '回答从哪里来 — 点击切换',
    'chat.scope.hint': '现在的回答依据是 {b}。要换成 {others}，在这里切换。',
    'chat.scope.hintOr': '或',
    'chat.scope.gotIt': '知道了',

    'chat.empty.wikiEmptyTitle': '{wiki}/ 里还什么都没有',
    'chat.empty.wikiEmpty': '点下方的「扫描文件夹」，从你的笔记起草卡片。',
    'chat.empty.wiki': '只读你批准过的卡片和概念页。',
    'chat.empty.vault': '先搜索仓库里的所有笔记，然后 Gemma 4 E4B 给出它自己的回答，并标明是它自己的。',
    'chat.empty.note': '只读 {note}，按你写的原样。',
    'chat.empty.noNote': '打开一篇笔记，就可以问它。',

    'chat.chip.findNotes': '找相关笔记…',
    'chat.chip.explain': '解释一个词…',
    'chat.chip.outline': '起草大纲…',
    'chat.chip.summarize': '总结',
    'chat.chip.tidy': '整理格式',
    'chat.chip.addToWiki': '加入 Wiki',
    'chat.chip.scan': '扫描文件夹',
    'chat.chip.connections': '找联系',
    'chat.chip.ingestThis': '把这篇笔记收进 Wiki',
    'chat.chip.stopScan': '停止扫描',
    'chat.chip.stopScanTip': '等正在起草的这篇写完后停止',
    'chat.chip.stopping': '正在停止 — 正在起草的这篇会先写完。',
    'chat.chip.scanTip': '选择文件夹，看每个有多少笔记，再为每篇起草一页',
    'chat.chip.ingestTip': '从你打开的笔记起草一页 Wiki — 写入前你会先审阅',
    'chat.chip.improveTip': '编辑这篇笔记 — 写入前你会先审阅',

    'chat.busy': '正忙：{what}',
    'chat.busyWait': '正忙：{what}。请等它完成。',
    'chat.busySomething': '另一项任务',

    'chat.context.note.one': '你的笔记 · {n} 个文件',
    'chat.context.note.other': '你的笔记 · {n} 个文件',
    'chat.context.vaultOff': '只用 Gemma 4 E4B · 不搜索笔记',
    'chat.context.wikiEmpty': '{wiki}/ · 空 — 扫描文件夹来建立',
    'chat.context.cards.one': '{wiki}/ · {n} 张卡片',
    'chat.context.cards.other': '{wiki}/ · {n} 张卡片',
    'chat.context.concepts.one': '，{n} 个概念页',
    'chat.context.concepts.other': '，{n} 个概念页',
    'chat.context.noNote': '没有打开笔记',
    'chat.context.inWiki': '已在 Wiki 中',

    'chat.input.note': '问这篇笔记…（Enter 发送）',
    'chat.input.wiki': '跨 {wiki}/ 的所有卡片提问…（Enter 发送）',
    'chat.input.vault': '随便问 — 先查你的笔记，再由 Gemma 4 E4B 回答（Enter 发送）',
    'chat.input.vaultOff': '随便问 — 由 Gemma 4 E4B 回答，不搜索你的笔记（Enter 发送）',
    'chat.input.expand': '展开输入框',
    'chat.input.shrink': '收起输入框',
    'chat.notesFirst': '先查笔记',
    'chat.notesFirstTip': '先搜索我的笔记。取消勾选则不搜索，直接问 Gemma 4 E4B。',
    'chat.attach': '添加笔记作为上下文',
    'chat.attachPlaceholder': '选择要附加为上下文的笔记…',
    'chat.removeAttached': '移除',
    'chat.stop': '停止',
    'chat.send': '发送（Enter）',

    'chat.skills': '运行技能',
    'chat.skills.quiz': '测验',
    'chat.skills.flashcards': '抽认卡',
    'chat.skills.gaps': '找空白',
    'chat.skills.folders': '文件夹结构',
    'chat.skills.switchTo': '切换到 {mode} 才能使用这些',

    'chat.sources.cards': '卡片',
    'chat.sources.notes': '笔记',
    'chat.sources.sources': '来源',
    'chat.generalKnowledge': '⚠ Gemma 的一般知识 — 不是来自你的笔记',
    'chat.part.notes': '来自你的笔记',
    'chat.part.shape': '来自你仓库的结构',
    'chat.part.adds': 'Gemma 4 E4B 补充',

    'chat.edit': '编辑',
    'chat.editLabel': '编辑这个问题并重新提问',
    'chat.edit.replaces.one': '会替换后面的 {n} 条消息',
    'chat.edit.replaces.other': '会替换后面的 {n} 条消息',
    'chat.cancel': '取消',
    'chat.askAgain': '重新提问',

    'chat.answer.copy': '复制回答',
    'chat.answer.copied': '已复制。',
    'chat.answer.regenerate': '重新生成',
    'chat.answer.regenerateTip': '重新生成回答',
    'chat.answer.save': '把回答保存到 Wiki',
    'chat.answer.saveTip': '保存为笔记',
    'chat.reviewBeforeWriting': '写入前先审阅笔记',
    'chat.saved': '已保存：{path}',
    'chat.saveNothing': '还没有可保存的内容 — 先问点什么。',
    'chat.saveFailed': '无法保存对话 — {reason}',
    'chat.failed': '失败：{reason}',

    'chat.history.placeholder': '搜索过去的对话…',
    'chat.history.noMatch': '没有匹配的对话。',
    'chat.history.reopen': '重新打开',
    'chat.history.close': '关闭',
    'chat.history.meta.one': '{mode} · {n} 个问题 · {when}',
    'chat.history.meta.other': '{mode} · {n} 个问题 · {when}',
    'chat.history.delete': '删除「{title}」',
    'chat.history.deleteTip': '删除这个对话',
    'chat.history.none': '还没有过去的对话。点 ＋ 开始新对话，当前这个会移到这里。',
    'chat.history.busy': '请等回答完成，或按停止，然后再重新打开。',
    'chat.history.saveFailed': '无法保存对话历史 — {reason}',
    'chat.restored.session': '已从上次会话恢复。',
    'chat.restored.history': '已从对话历史重新打开。',
    'chat.restored.moved':
      '{lead}这些回答是关于「{name}」的；现在这个面板依据的是你打开的笔记，所以后续问题会从那篇笔记回答。',
    'chat.restored.anotherNote': '另一篇笔记',

    'chat.searching': '正在搜索 {n} 篇笔记…',
    'chat.searchingFor': '正在搜索 {n} 篇笔记：{terms}',
    'chat.nothing': '你的笔记里没有专门讲这个的。',
    'chat.nothing.passing.one': '你的笔记里没有专门讲这个的 — 有 {n} 篇顺带提到：',
    'chat.nothing.passing.other': '你的笔记里没有专门讲这个的 — 有 {n} 篇顺带提到：',
    'chat.nothing.record': '你的笔记里没有专门讲这个的。没有询问 Gemma 4 E4B。',
    'chat.nothing.askAnyway': '仍然问 Gemma 4 E4B',
    'chat.listSeparator': '、',
    'chat.listEnd': '。',
    'chat.vault.notSearched': '没有搜索你的笔记。',
    'chat.vault.searchAgain': '搜索我的笔记并重新提问',
    'chat.vault.tally.one': '{about} 篇专门讲 · {n} 篇提到',
    'chat.vault.tally.other': '{about} 篇专门讲 · {n} 篇提到',
    'chat.vault.about': '专门讲这个主题',
    'chat.vault.mentions': '顺带提到',

    'chat.route.wiki': '问 Wiki',
    'chat.route.note': '问打开的笔记',
    'chat.route.vault': '在整个仓库里问',
    'chat.route.fromNote': '这篇笔记里没有？试试它生成的 Wiki，或仓库里的所有笔记：',
    'chat.route.fromWiki': 'Wiki 里没有？试试你打开的笔记，或仓库里的所有笔记：',
    'chat.route.collection.one': '跨整个收藏的问题正是 Wiki 擅长的 — 你有 {n} 张卡片。',
    'chat.route.collection.other': '跨整个收藏的问题正是 Wiki 擅长的 — 你有 {n} 张卡片。',
    'chat.route.collectionEmpty':
      '跨整个收藏的问题正是 Wiki 擅长的。先用「扫描文件夹」建立卡片 — {wiki}/ 里还什么都没有。',

    'chat.info.wikiEmpty':
      '你的 {wiki}/ 文件夹是空的，没有可依据的内容。先建立它（不经你批准不会写入任何东西），或切换到仓库，直接搜索你的笔记。',
    'chat.info.noNote': '先打开一篇笔记，或用 ＋ 按钮附加一篇 — 当前笔记模式需要有依据的内容。',
    'chat.info.cutWiki': '检索到的资料只发送了前约 {k}k 个 token — 为了让一次回答保持快速，其余部分被截掉了。',
    'chat.info.cutNote':
      '这篇笔记只发送了前约 {k}k 个 token — 为了让一次回答保持快速，其余部分被截掉了。要发送更多，可在设置里调大上下文窗口，或选中一部分再就那部分提问。',

    'settings.language.name': '界面语言',
    'settings.language.desc': '聊天面板和本页的语言。默认跟随 Obsidian。发给模型的提示词和插件写进仓库的内容仍是英文。',
    'settings.language.auto': '跟随 Obsidian',
    'settings.language.reopen': '聊天面板正在回答，结束后重新打开即可看到新语言。',

    'settings.demo.before': '第一次用？所有功能都在 ',
    'settings.demo.after': ' 演示 — 23 个短场景，无需安装。',

    'settings.group.model': '模型',
    'settings.group.wiki': 'Wiki',
    'settings.group.schema': 'Schema',
    'settings.group.skills': '技能',
    'settings.group.chat': '聊天',
    'settings.group.review': '复查',
    'settings.group.scan': '扫描新笔记',

    'settings.model.name': '本地模型',
    'settings.model.desc': '磁盘上的模型文件。',
    'settings.model.downloaded': '已下载（磁盘上 {gb} GB）。完全免费 — 在你的 GPU 上离线运行，不需要 API 密钥或订阅。',
    'settings.model.partial': '已下载一部分（{gb} GB）。继续下载即可完成。',
    'settings.model.missing': '尚未下载（约 2.97 GB，只需一次）。第一次使用时会自动下载，也可以在这里开始。',
    'settings.model.redownload': '重新下载',
    'settings.model.resume': '继续下载',
    'settings.model.download': '下载模型',

    'settings.check.name': '检查设置',
    'settings.check.desc':
      '检查第一次回答依赖的五样东西 — 桌面版、WebGPU、磁盘空间、运行时、模型 — 并说明缺了什么该怎么办。会生成一份可以贴进 bug 报告的报告，只包含版本号和文件大小，不含仓库里的任何内容。',
    'settings.check.run': '开始检查',

    'settings.context.name': '上下文窗口（token）',
    'settings.context.desc':
      '模型一次能容纳多少内容 — 更长的笔记能整篇放进去，回答也能依据更多资料。代价是 GPU 内存和首个 token 的延迟。插件重新加载后生效。调高后如果模型加载失败或回答变差，请调低。',
    'settings.context.small': '4,096（小 / 最稳妥）',
    'settings.context.max': '64,000（最大）',
    'settings.context.saved': '上下文窗口已保存 — 重新加载插件（关闭再打开）后生效。',

    'settings.dev.name': '开发者命令',
    'settings.dev.desc':
      '在命令面板里加入 [Test] 命令：检查 WebGPU、不加载模型只加载 WASM 运行时、测一次语法修正的耗时、跑 JSON 可靠性测试、给这台电脑做基准测试。它们用来排查出问题的配置，不是用来处理笔记的。默认关闭。',
    'settings.dev.reload': '重新加载插件（关闭再打开）后生效。',

    'settings.folder.name': '知识库文件夹名',
    'settings.folder.desc':
      '插件唯一会写入的文件夹。你自己的笔记永远不会被移动或修改。修改这里会重命名文件夹并改写内部链接；留空则恢复默认。',
    'settings.folder.apply': '应用',
    'settings.folder.notFolder': '“{name}”已存在，而且不是文件夹。',
    'settings.folder.renameTitle': '重命名知识库文件夹',
    'settings.folder.renameMoves.one': '将移动 {n} 个文件，指向“{prev}/”的链接会被改写。',
    'settings.folder.renameMoves.other': '将移动 {n} 个文件，指向“{prev}/”的链接会被改写。',
    'settings.folder.renameEmpty': '“{prev}/”是空的或不存在，所以不会移动任何东西 — 只会在“{next}/”下创建文件夹。',
    'settings.folder.renameCheck': '请检查拼写：如果名字不是你想要的，现有的 wiki 会被留在原处。',
    'settings.folder.renameConfirm': '重命名',

    'settings.map.name': '插件创建的内容',
    'settings.map.desc': '这个插件管理的每个文件夹和文件，以及它们是否存在。',
    'settings.map.missing': '缺失',

    'settings.repair.name': '文件夹',
    'settings.repair.desc': 'Obsidian 启动时会自动创建；这里只用来补回缺失的。',
    'settings.repair.someMissing': '{total} 个中缺了 {n} 个 — 它们通常在 Obsidian 启动时创建。',
    'settings.repair.allPresent': '全部都在。它们在 Obsidian 启动时创建；这个按钮只用来补回缺失的。',
    'settings.repair.createMissing': '创建缺失的 {n} 个',
    'settings.repair.button': '修复文件夹',

    'settings.setupCard.name': '这个插件创建了什么',
    'settings.setupCard.desc':
      '第一次创建文件夹时显示的卡片 — 每个文件夹的用途，以及聊天面板在哪里。故意只显示一次；想再看就在这里打开。',
    'settings.setupCard.button': '显示设置卡片',

    'settings.tags.name': '标签词表和命名规则',
    'settings.tags.desc':
      '标签规则写在 schema.md 里，不在这里 — 把配置写成一篇笔记；可以从上面的列表打开。“整理标签”会让本地 Gemma 把近义词合并成一份词表，再写回去供你审核。第一次运行时加载模型会比较慢。',
    'settings.tags.button': '整理标签',

    'settings.skills.name': '自定义技能',
    'settings.skills.desc':
      'skills/ 里每个技能一个文件 — frontmatter 写 name/icon/mode，正文就是提示词。每个文件会成为聊天面板 ⚡ 菜单里的一项。文件夹里自带一个 README 和两个例子。',
    'settings.skills.button': '打开技能文件夹',

    'settings.mode.name': '默认模式',
    'settings.mode.desc': '新打开的聊天面板一开始使用的模式。',

    'settings.instructions.name': '固定指令',
    'settings.instructions.desc':
      '加到每种模式的每次回答里 — 语言、长度、语气、格式。它们决定回答怎么写，不决定回答能依据什么：有依据的模式仍然只根据你的资料回答。最多 2,000 个字符。',
    'settings.instructions.placeholder': '用中文回答。每次回答不超过 150 字。',

    'settings.stale.name': '多少天后算过时',
    'settings.stale.desc': '页面多久没更新后，复查面板会把它标为过时。',

    'settings.howToScan.name': '如何扫描',
    'settings.howToScan.desc':
      'Cmd/Ctrl+P →“Scan a folder into the wiki”，或在 wiki 为空时点聊天面板里的按钮。它会问你扫描哪些文件夹，显示每个文件夹有多少笔记，并记住你上次的选择。“Stop the running scan”可以取消 — 取消前已经生成的草稿仍会交给你审核。',

    'settings.answerFolder.name': '回答保存到',
    'settings.answerFolder.desc':
      '回答下方的保存按钮写到哪里。留空则保存在回答所依据的笔记旁边 — Wiki 模式下是第一个来源对应的笔记旁边。在这里填一个文件夹名，就会把所有保存的回答放在一处。无论哪种，它都是你的普通笔记，下次扫描时可以像其他笔记一样生成 wiki 卡片。',
    'settings.answerFolder.placeholder': '保存在来源笔记旁边',

    'settings.exclude.name': '永不扫描这些文件夹',
    'settings.exclude.desc':
      '不是笔记的文件夹 — 模板、附件、归档。无论你在对话框里勾选了什么，所有扫描和后台计数都会跳过它们（用逗号分隔）。wiki 文件夹总是被排除。',
    'settings.exclude.placeholder': 'Templates, Attachments',

    'settings.count.name': '在后台显示“待审核”数量',
    'settings.count.desc':
      '定期统计新增或修改过的笔记，显示在状态栏。统计是瞬间完成的，不会运行模型 — 只有你点那个标签时才会生成草稿。默认关闭。',

    'settings.quiet.name': '静默期（小时）',
    'settings.quiet.desc': '后台自动扫描会跳过这么多小时内编辑过的笔记 — 你可能还在写。手动“立即扫描”总会包含它们。',

    'settings.recount.name': '重新统计间隔（小时）',
    'settings.recount.desc': 'Obsidian 打开期间，后台数量多久刷新一次。',

    'scaffold.readme': '这个文件夹的说明和规则',
    'scaffold.cards': '每篇导入的笔记一张摘要卡片',
    'scaffold.concepts': '跨同一标签生成的页面',
    'scaffold.skills': '⚡ 菜单每一项一个文件',
    'scaffold.chats': '你选择保留的对话',
    'scaffold.index': '目录 — wiki 聊天最先读它',
    'scaffold.log': '只追加的运行记录',
    'scaffold.schema': '标签词表、命名规则、被拒绝的标签',
  },
};
