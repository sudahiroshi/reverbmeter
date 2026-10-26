# Lessons Learned

## 2026-03-08

### AudioContext must be explicitly resumed
- **問題**: ブラウザのAutoplay Policyにより、AudioContextが自動的に`suspended`状態になる
- **解決**: `audioCtx.resume()`をユーザージェスチャー後に明示的に呼び出す
- **ルール**: AudioContextを使う場合は必ず`state`チェック+`resume()`を入れる

### Float32Arrayは直接JSON.stringifyできない
- **問題**: 測定結果の`rawIR`(Float32Array)をLocalStorageに保存しようとするとJSON化に失敗
- **解決**: rawIRを保存対象から除外。また`NaN`/`Infinity`を`null`に変換する`sanitizeForStorage`関数を追加
- **ルール**: LocalStorageに保存する前にデータのシリアライズ安全性を確認する

### async関数の戻り値は必ずawaitする
- **問題**: `analyzeImpulseResponse`が内部で`processOctaveBands`(async)を呼んでいるがPromiseが返り、finishRecordingでawaitされていなかった
- **解決**: `finishRecording`をasyncにして`await`を追加
- **ルール**: Promiseを返す関数は呼び出し元でawaitされているか確認する

## 2026-10-26

### 検証用データを LocalStorage へ仕込む前に既存の値を退避する
- **問題**: localhost の LocalStorage にはユーザーの保存データが入っていたが、確認せずに `setItem` で上書きした
- **解決**: 上書き直後に、ページ内に残っていた元の値を別キーへ退避してから作業を続け、最後に復元した
- **ルール**: 仕込む前に `getItem` で既存の値を確認し、リロードで消えない場所（別キー等）へ退避してから書き込む

### ブラウザ検証は既存データのないオリジンで行う
- **背景**: 前回、localhost の LocalStorage にあるユーザーの保存データを上書きした
- **やり方**: 普段使われていないポートでサーバを立て、アプリ以外のページ（ディレクトリ一覧など）で `localStorage.length === 0` を確かめてからアプリを開く。最後に自分が作ったキーだけを消して 0 件に戻す
- **ルール**: オリジンはポートまで含めて別になる。検証用データは、ユーザーのデータと混ざらないオリジンで作る

### beforeunload を入れたアプリを自動操作でリロードしない
- **問題**: 未保存の結果があると、リロードや離脱でブラウザ標準の確認が出て、自動操作が止まる
- **ルール**: リロード・離脱の前に、合成した beforeunload イベントの `defaultPrevented` で未保存でないことを確かめる。未保存なら保存してから移る

### 検証用の静的サーバではキャッシュを切る
- **問題**: `python3 -m http.server` で配った JS をブラウザがキャッシュし、編集後もリロードで古い ui.js が動いていた
  （新しい measurement.js と古い ui.js が混ざって表示された）
- **ルール**: 検証用サーバは `Cache-Control: no-store` を付ける。関数の文字列などで新しいコードが読み込まれたことを確かめてから判定する

### アプリを開いたまま LocalStorage を消さない
- **問題**: 片付けで LocalStorage を消したら、表示中の保存データが「未保存」扱いになり、beforeunload でタブを閉じられなくなった
- **ルール**: 片付けは、アプリのタブで未保存でないことを確かめて閉じてから、同じオリジンのアプリ以外のページで行う

### 自動操作中のタブでは requestAnimationFrame が止まることがある
- **背景**: 操作中のタブが `document.hidden` になり、メーターが -60 のまま更新されなかった（スクリーンショットのときだけ描画が進む）
- **ルール**: rAF で描く表示が止まって見えたら、まず `document.visibilityState` を確かめる。アプリの不具合と決めつけない

### 表示する数値は、予約した量ではなく実際に起きる量で確かめる
- **問題**: 測定時間の目安は再生を（回数 + 2）周期と数えていたが、録音がそろうと再生を止めるため実際は（回数 + 1）周期だった
- **ルール**: 「〜秒」「〜回」などの説明を書くときは、コードの経路を最後まで追い、可能ならブラウザで実測する
