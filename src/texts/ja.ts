import type { Language } from './index.ts';

// Machine-assisted translation, not yet reviewed by a native speaker (#166).
// A key missing here shows the English text.
export const ja: Language = {
  code: 'ja',
  name: '日本語',
  texts: {
    'chat.viewTitle': 'ノートと対話',
    'chat.badge': 'ローカル',
    'chat.header.save': '会話をノートとして保存',
    'chat.header.new': '新しいチャット',
    'chat.header.history': 'チャット履歴',

    'chat.scope.note.label': 'このノート',
    'chat.scope.note.desc': '開いているノートだけ',
    'chat.scope.note.title': 'このノートについて質問',
    'chat.scope.vault.label': '保管庫',
    'chat.scope.vault.desc': '保管庫のどのノートでも、一般的な質問でも',
    'chat.scope.vault.title': '何でも質問',
    'chat.scope.wiki.label': 'Wiki',
    'chat.scope.wiki.desc': '{wiki}/ のカードと、そのつながり',
    'chat.scope.wiki.title': '{wiki}/ のカードに質問',
    'chat.scope.heading': '回答のもと',
    'chat.scope.caption': '入力欄の下の {b} からいつでも変更できます。',
    'chat.scope.buttonLabel': '回答のもと: {mode}。変更',
    'chat.scope.buttonTip': '回答のもと — クリックで変更',
    'chat.scope.hint': '回答は {b} から。{others} への切り替えはここから。',
    'chat.scope.hintOr': '・',
    'chat.scope.gotIt': 'わかった',

    'chat.empty.wikiEmptyTitle': '{wiki}/ にはまだ何もありません',
    'chat.empty.wikiEmpty': '下の「フォルダーをスキャン」で、ノートからカードの下書きを作れます。',
    'chat.empty.wiki': 'あなたが承認したカードと概念ページだけを読みます。',
    'chat.empty.vault': '保管庫のすべてのノートを検索し、そのあと Gemma 4 E4B 自身の答えを、それと分かる形で添えます。',
    'chat.empty.note': '{note} だけを、書かれたとおりに読みます。',
    'chat.empty.noNote': 'ノートを開くと、そのノートについて質問できます。',

    'chat.chip.findNotes': '関連するノートを探す…',
    'chat.chip.explain': '用語を説明…',
    'chat.chip.outline': 'アウトラインを作る…',
    'chat.chip.summarize': '要約',
    'chat.chip.tidy': '書式を整える',
    'chat.chip.addToWiki': 'Wiki に追加',
    'chat.chip.scan': 'フォルダーをスキャン',
    'chat.chip.connections': 'つながりを探す',
    'chat.chip.ingestThis': 'このノートを Wiki に取り込む',
    'chat.chip.stopScan': 'スキャンを停止',
    'chat.chip.stopScanTip': 'いま下書き中のノートが終わったところで停止します',
    'chat.chip.stopping': '停止します — いま下書き中のノートは最後まで仕上げます。',
    'chat.chip.scanTip': 'フォルダーを選び、それぞれのノート数を確認してから、1 ノートずつページの下書きを作ります',
    'chat.chip.ingestTip': '開いているノートから Wiki のページを 1 枚下書きします — 書き込む前に確認できます',
    'chat.chip.improveTip': 'このノートを編集します — 書き込む前に確認できます',

    'chat.busy': '実行中: {what}',
    'chat.busyWait': '実行中: {what}。終わるまでお待ちください。',
    'chat.busySomething': '別の処理',

    'chat.context.note.one': 'あなたのノート · {n} 件',
    'chat.context.note.other': 'あなたのノート · {n} 件',
    'chat.context.vaultOff': 'Gemma 4 E4B のみ · ノートは検索しません',
    'chat.context.wikiEmpty': '{wiki}/ · 空 — フォルダーをスキャンして作成',
    'chat.context.cards.one': '{wiki}/ · カード {n} 枚',
    'chat.context.cards.other': '{wiki}/ · カード {n} 枚',
    'chat.context.concepts.one': '、概念ページ {n} 枚',
    'chat.context.concepts.other': '、概念ページ {n} 枚',
    'chat.context.noNote': 'ノートが開かれていません',
    'chat.context.inWiki': 'Wiki に取り込み済み',

    'chat.input.note': 'このノートについて質問…（Enter で送信）',
    'chat.input.wiki': '{wiki}/ のカード全体に質問…（Enter で送信）',
    'chat.input.vault': '何でも質問 — まずあなたのノート、次に Gemma 4 E4B（Enter で送信）',
    'chat.input.vaultOff': '何でも質問 — Gemma 4 E4B が答えます。ノートは検索しません（Enter で送信）',
    'chat.input.expand': '入力欄を広げる',
    'chat.input.shrink': '入力欄を縮める',
    'chat.notesFirst': 'ノート優先',
    'chat.notesFirstTip': 'まずノートを検索します。外すと検索せずに Gemma 4 E4B に直接尋ねます。',
    'chat.attach': 'ノートを文脈として追加',
    'chat.attachPlaceholder': '文脈として添付するノート…',
    'chat.removeAttached': '外す',
    'chat.stop': '停止',
    'chat.send': '送信（Enter）',

    'chat.skills': 'スキルを実行',
    'chat.skills.quiz': 'クイズ',
    'chat.skills.flashcards': '暗記カード',
    'chat.skills.gaps': '抜けを探す',
    'chat.skills.folders': 'フォルダー構成',
    'chat.skills.switchTo': '使うには {mode} に切り替えてください',

    'chat.sources.cards': 'カード',
    'chat.sources.notes': 'ノート',
    'chat.sources.sources': '出典',
    'chat.generalKnowledge': '⚠ Gemma の一般知識 — あなたのノートからではありません',
    'chat.part.notes': 'あなたのノートから',
    'chat.part.shape': '保管庫の構成から',
    'chat.part.adds': 'Gemma 4 E4B の補足',

    'chat.edit': '編集',
    'chat.editLabel': 'この質問を編集して聞き直す',
    'chat.edit.replaces.one': '以降の {n} 件のメッセージを置き換えます',
    'chat.edit.replaces.other': '以降の {n} 件のメッセージを置き換えます',
    'chat.cancel': 'キャンセル',
    'chat.askAgain': '聞き直す',

    'chat.answer.copy': '回答をコピー',
    'chat.answer.copied': 'コピーしました。',
    'chat.answer.regenerate': '再生成',
    'chat.answer.regenerateTip': '回答を再生成',
    'chat.answer.save': '回答を Wiki に保存',
    'chat.answer.saveTip': 'ノートとして保存',
    'chat.reviewBeforeWriting': '書き込む前にノートを確認',
    'chat.saved': '保存しました: {path}',
    'chat.saveNothing': 'まだ保存するものがありません — まず何か質問してください。',
    'chat.saveFailed': '会話を保存できませんでした — {reason}',
    'chat.failed': '失敗しました: {reason}',

    'chat.history.placeholder': '過去のチャットを検索…',
    'chat.history.noMatch': '一致するチャットはありません。',
    'chat.history.reopen': '開き直す',
    'chat.history.close': '閉じる',
    'chat.history.meta.one': '{mode} · 質問 {n} 件 · {when}',
    'chat.history.meta.other': '{mode} · 質問 {n} 件 · {when}',
    'chat.history.delete': '「{title}」を削除',
    'chat.history.deleteTip': 'このチャットを削除',
    'chat.history.none': '過去のチャットはまだありません。＋ で新しいチャットを始めると、いまの会話がここに移ります。',
    'chat.history.busy': '回答が終わるのを待つか、停止を押してから開き直してください。',
    'chat.history.saveFailed': 'チャット履歴を保存できませんでした — {reason}',
    'chat.restored.session': '前回のセッションから復元しました。',
    'chat.restored.history': 'チャット履歴から開き直しました。',
    'chat.restored.moved':
      '{lead}これらの回答は「{name}」についてのものです。いまこのパネルは開いているノートをもとにしているので、続きの質問はそのノートから答えます。',
    'chat.restored.anotherNote': '別のノート',

    'chat.searching': '{n} 件のノートを検索中…',
    'chat.searchingFor': '{n} 件のノートを検索中: {terms}',
    'chat.nothing': 'このことを主題にしたノートはありません。',
    'chat.nothing.passing.one': 'このことを主題にしたノートはありません — {n} 件が触れています: ',
    'chat.nothing.passing.other': 'このことを主題にしたノートはありません — {n} 件が触れています: ',
    'chat.nothing.record': 'このことを主題にしたノートはありません。Gemma 4 E4B には尋ねていません。',
    'chat.nothing.askAnyway': 'それでも Gemma 4 E4B に尋ねる',
    'chat.listSeparator': '、',
    'chat.listEnd': '。',
    'chat.vault.notSearched': 'ノートは検索していません。',
    'chat.vault.searchAgain': 'ノートを検索して聞き直す',
    'chat.vault.tally.one': '主題 {about} 件 · 言及 {n} 件',
    'chat.vault.tally.other': '主題 {about} 件 · 言及 {n} 件',
    'chat.vault.about': 'この主題についてのノート',
    'chat.vault.mentions': 'ついでに触れているノート',

    'chat.route.wiki': 'Wiki に尋ねる',
    'chat.route.note': '開いているノートに尋ねる',
    'chat.route.vault': '保管庫全体に尋ねる',
    'chat.route.fromNote': 'このノートにはありませんか？ このノートから作った Wiki か、保管庫のすべてのノートへ:',
    'chat.route.fromWiki': 'Wiki にはありませんか？ 開いているノートか、保管庫のすべてのノートへ:',
    'chat.route.collection.one': 'コレクション全体にまたがる質問は Wiki の役目です — カードは {n} 枚あります。',
    'chat.route.collection.other': 'コレクション全体にまたがる質問は Wiki の役目です — カードは {n} 枚あります。',
    'chat.route.collectionEmpty':
      'コレクション全体にまたがる質問は Wiki の役目です。まず「フォルダーをスキャン」でカードを作ってください — {wiki}/ にはまだ何もありません。',

    'chat.info.wikiEmpty':
      '{wiki}/ フォルダーは空なので、答えるもとがありません。先に作成してください（承認なしには何も書き込みません）。または保管庫に切り替えて、ノートをそのまま検索してください。',
    'chat.info.noNote': '先にノートを開くか、＋ ボタンで添付してください — このノートモードには、もとになるものが必要です。',
    'chat.info.cutWiki': '取得した資料は先頭の約 {k}k トークンだけを送りました — 1 回の回答を速くするため、残りは省いています。',
    'chat.info.cutNote':
      'このノートは先頭の約 {k}k トークンだけを送りました — 1 回の回答を速くするため、残りは省いています。もっと送るには設定でコンテキストウィンドウを上げるか、一部を選択してそこについて質問してください。',

    'settings.language.name': '表示言語',
    'settings.language.desc':
      'チャットパネルとこのページの言語です。既定では Obsidian に合わせます。モデルへのプロンプトと、プラグインが保管庫に書き込む内容は英語のままです。',
    'settings.language.auto': 'Obsidian と同じ',
    'settings.language.reopen': 'チャットパネルが回答中です。終わったら開き直すと新しい言語で表示されます。',

    'settings.demo.before': '初めての方へ：すべての機能は ',
    'settings.demo.after': ' で見られます — 短いシーンが 23 本、インストール不要です。',

    'settings.group.model': 'モデル',
    'settings.group.wiki': 'Wiki',
    'settings.group.schema': 'スキーマ',
    'settings.group.skills': 'スキル',
    'settings.group.chat': 'チャット',
    'settings.group.review': 'レビュー',
    'settings.group.scan': '新しいノートのスキャン',

    'settings.model.name': 'ローカルモデル',
    'settings.model.desc': 'ディスク上のモデルファイルです。',
    'settings.model.downloaded':
      'ダウンロード済み（ディスク上 {gb} GB）。完全無料 — GPU 上でオフライン動作し、API キーもサブスクリプションも不要です。',
    'settings.model.partial': '途中までダウンロード済み（{gb} GB）。再開すると完了します。',
    'settings.model.missing': '未ダウンロード（約 2.97 GB、1 回だけ）。最初に使うときにダウンロードされます。ここから始めることもできます。',
    'settings.model.redownload': '再ダウンロード',
    'settings.model.resume': 'ダウンロードを再開',
    'settings.model.download': 'モデルをダウンロード',

    'settings.check.name': 'セットアップを確認',
    'settings.check.desc':
      '最初の回答に必要な 5 つ — デスクトップ、WebGPU、ディスク容量、ランタイム、モデル — を確認し、足りないものへの対処法を示します。バグ報告に貼れるレポートを作ります。含まれるのはバージョンとファイルサイズだけで、保管庫の内容は含まれません。',
    'settings.check.run': '確認を実行',

    'settings.context.name': 'コンテキストウィンドウ（トークン）',
    'settings.context.desc':
      'モデルが一度に扱える量です。長いノートも丸ごと入り、回答はより多くの資料にもとづけます。GPU メモリと最初のトークンまでの時間を使います。プラグインの再読み込み後に反映されます。上げたあとにモデルが読み込めない、または回答の質が落ちる場合は下げてください。',
    'settings.context.small': '4,096（小 / 最も安全）',
    'settings.context.max': '64,000（最大）',
    'settings.context.saved': 'コンテキストウィンドウを保存しました — 反映するにはプラグインを再読み込み（オフにしてオン）してください。',

    'settings.dev.name': '開発者コマンド',
    'settings.dev.desc':
      'コマンドパレットに [Test] コマンドを追加します：WebGPU の確認、モデルなしでの WASM ランタイムの読み込み、文法修正の計測、JSON 信頼性テスト、このマシンのベンチマーク。セットアップの不具合を調べるためのもので、ノートの作業用ではありません。既定はオフです。',
    'settings.dev.reload': '反映するにはプラグインを再読み込み（オフにしてオン）してください。',

    'settings.folder.name': 'ナレッジフォルダー名',
    'settings.folder.desc':
      'プラグインが書き込む唯一のフォルダーです。あなたのノートが移動・変更されることはありません。変更するとフォルダー名が変わり、内部リンクが書き換えられます。空欄にすると既定値に戻ります。',
    'settings.folder.apply': '適用',
    'settings.folder.notFolder': '「{name}」はすでに存在し、フォルダーではありません。',
    'settings.folder.renameTitle': 'ナレッジフォルダーの名前を変更',
    'settings.folder.renameMoves.one': '{n} 個のファイルが移動し、「{prev}/」を指すリンクが書き換えられます。',
    'settings.folder.renameMoves.other': '{n} 個のファイルが移動し、「{prev}/」を指すリンクが書き換えられます。',
    'settings.folder.renameEmpty':
      '「{prev}/」は空か存在しないため、何も移動しません — フォルダーが「{next}/」の下に作られるだけです。',
    'settings.folder.renameCheck': '綴りを確認してください。意図しない名前にすると、今の Wiki が取り残されます。',
    'settings.folder.renameConfirm': '名前を変更',

    'settings.map.name': 'プラグインが作ったもの',
    'settings.map.desc': 'このプラグインが管理するフォルダーとファイルの一覧と、それぞれが存在するかどうかです。',
    'settings.map.missing': 'なし',

    'settings.repair.name': 'フォルダー',
    'settings.repair.desc': 'Obsidian の起動時に作られます。これは 1 つ戻すためだけのものです。',
    'settings.repair.someMissing': '{total} 個中 {n} 個がありません — 通常は Obsidian の起動時に作られます。',
    'settings.repair.allPresent':
      'すべてあります。これらは Obsidian の起動時に作られます。このボタンは 1 つ戻すためだけのものです。',
    'settings.repair.createMissing': '足りない {n} 個を作成',
    'settings.repair.button': 'フォルダーを修復',

    'settings.setupCard.name': 'このプラグインが作ったもの',
    'settings.setupCard.desc':
      'フォルダーを最初に作ったときに表示したカードです — 各フォルダーの役割と、チャットパネルの場所。意図して 1 回だけ表示しています。もう一度見るにはここから。',
    'settings.setupCard.button': 'セットアップカードを表示',

    'settings.tags.name': 'タグの語彙と命名ルール',
    'settings.tags.desc':
      'タグのルールはここではなく schema.md にあります — ノートとしての設定です。上の一覧から開けます。「タグを整理」はローカルの Gemma が近い同義語を 1 つの語彙にまとめ、確認用に書き戻します。初回はモデルの読み込みで時間がかかります。',
    'settings.tags.button': 'タグを整理',

    'settings.skills.name': 'カスタムスキル',
    'settings.skills.desc':
      'skills/ にスキルごとに 1 ファイル — frontmatter に name/icon/mode、本文がプロンプトです。各ファイルがチャットパネルの ⚡ メニューの項目になります。フォルダーには README と例が 2 つ入っています。',
    'settings.skills.button': 'スキルフォルダーを開く',

    'settings.mode.name': '既定のモード',
    'settings.mode.desc': '新しく開いたチャットパネルが最初に使うモードです。',

    'settings.instructions.name': '常時の指示',
    'settings.instructions.desc':
      'すべてのモードのすべての回答に加えられます — 言語、長さ、口調、形式など。回答の書き方を決めるもので、何にもとづくかは変えません。資料にもとづくモードは、引き続きあなたの資料だけから答えます。最大 2,000 文字。',
    'settings.instructions.placeholder': '日本語で答えて。150 語以内に。',

    'settings.stale.name': '古いとみなす日数',
    'settings.stale.desc': 'レビューボードがページを古いとみなすまでの日数です。',

    'settings.howToScan.name': 'スキャンの実行方法',
    'settings.howToScan.desc':
      'Cmd/Ctrl+P →「Scan a folder into the wiki」、または Wiki が空のときはチャットパネルのボタンから。どのフォルダーかを尋ね、それぞれのノート数を示し、前回の選択を覚えています。「Stop the running scan」で中止できます — 中止前に作られた下書きは、そのままレビューに回されます。',

    'settings.answerFolder.name': '回答の保存先',
    'settings.answerFolder.desc':
      '回答の下の保存ボタンが書き込む場所です。空欄なら、回答のもとになったノートの隣に保存します — Wiki モードでは、最初の出典の元ノートの隣です。フォルダー名を入れると、保存した回答をすべてそこにまとめます。どちらの場合もあなたの普通のノートなので、次のスキャンで他のノートと同じように Wiki カードにできます。',
    'settings.answerFolder.placeholder': 'もとのノートの隣',

    'settings.exclude.name': 'スキャンしないフォルダー',
    'settings.exclude.desc':
      'ノートではないフォルダー — テンプレート、添付ファイル、アーカイブなど。ダイアログで何を選んでも、すべてのスキャンとバックグラウンドの件数から除外されます（カンマ区切り）。Wiki フォルダーは常に除外されます。',
    'settings.exclude.placeholder': 'Templates, Attachments',

    'settings.count.name': 'バックグラウンドで「レビュー待ち」の件数を表示',
    'settings.count.desc':
      '新規・変更されたノートを定期的に数え、ステータスバーに表示します。数えるのは一瞬で、モデルは動きません — 下書きはチップをクリックしたときだけ作られます。既定はオフです。',

    'settings.quiet.name': '待機時間（時間）',
    'settings.quiet.desc':
      'バックグラウンドの自動スキャンは、この時間内に編集されたノートを飛ばします — まだ書いている途中かもしれないからです。手動の「今すぐスキャン」では常に含まれます。',

    'settings.recount.name': '再カウントの間隔（時間）',
    'settings.recount.desc': 'Obsidian を開いている間、バックグラウンドの件数を更新する間隔です。',

    'scaffold.readme': 'このフォルダーの説明とルール',
    'scaffold.cards': '取り込んだノートごとの要約カード',
    'scaffold.concepts': '共通のタグをまたいで作るページ',
    'scaffold.skills': '⚡ メニューの項目ごとに 1 ファイル',
    'scaffold.chats': '残すことにした会話',
    'scaffold.index': '目録 — Wiki チャットが最初に読む',
    'scaffold.log': '実行したことの追記専用の記録',
    'scaffold.schema': 'タグの語彙、命名ルール、却下したタグ',
  },
};
