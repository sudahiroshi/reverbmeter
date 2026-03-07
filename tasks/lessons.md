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
