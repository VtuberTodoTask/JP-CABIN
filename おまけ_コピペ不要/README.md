## これは何？
gemini pro君に作らせた、今回の翻訳データを作成するためのスクリプトです。  
最近のAIは賢くていいね！

## 使い方
まずはnodejsの実行環境を整えてください。俺の動作環境はv22.5.1でした。  
その後、必要なモジュールをインストールしてください。

```
npm install dotenv adm-zip openai deepl-node
```

あとは、 `.env` というファイルを作って、環境変数を整えてください。
openaiとdeeplのAPIトークンはここに設置します。

```
OPENAI_API_KEY=<openaiのキー>
DEEPL_API_KEY=<deeplのキー>
SOURCE_DIRECTORY="翻訳する対象のパス"
```

ここまで設定できたら実行するだけです。

```
# modの内容を翻訳する場合、以下のコマンドを実行するとリソースパックのtranslated_rp_openaiが作られます。
node ./indexModTranslator.js

# modpackの中身を翻訳する場合、以下のコマンドを実行すると翻訳対象のデータをdistフォルダに書き出します。
node ./index.js
```

## なんでOPENAIとDEEPLどっちも使ってるの？
個人的にはdeeplのほうが翻訳がまともになるから好きなんだけど、ちょっと制限が重い…。  
openaiは4o miniならめちゃくちゃ安く、1回のやりとりで複数の文章を一気に翻訳できるからmodの中身みたいな大量のデータを一気に翻訳するならこっちがいいというのもあります。