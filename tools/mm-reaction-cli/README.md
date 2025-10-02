# Mattermost Reaction CLI

Mattermost 게시글에 기본/커스텀 이모지 반응을 연속적으로 빠르게 추가하는 Node.js 스크립트입니다.

## 폴더 구조
```
mm_ex1/
  tools/
    mm-reaction-cli/
      add-reactions.js
      config.example.json
      emoji-map.example.json
      .gitignore
      README.md
      package.json
```

## 준비
1) Node.js 16 이상 설치
2) `config.json` 생성 (아래 예시를 복사)
3) (선택) `emoji-map.json` 생성: 숫자→이모지 이름 커스텀 매핑

### config.json 예시
`tools/mm-reaction-cli/config.example.json`를 복사해 `config.json`으로 저장 후 값 수정
```json
{
  "base": "https://your-mm.example.com",
  "token": "YOUR_PERSONAL_ACCESS_TOKEN",
  "postId": "TARGET_POST_ID",
  "seq": "0105092645",
  "emojis": ["thumbsup", "my_custom_1", "heart"],
  "emojisFile": "emojis.txt",
  "delayMs": 120,
  "mapFile": "emoji-map.json"
}
```

### emoji-map.json 예시(선택)
`tools/mm-reaction-cli/emoji-map.example.json`를 복사해 `emoji-map.json`으로 저장 후 값 수정
```json
{
  "0": "num_zero",
  "1": "num_one",
  "2": "num_two",
  "3": "num_three",
  "4": "num_four",
  "5": "num_five",
  "6": "num_six",
  "7": "num_seven",
  "8": "num_eight",
  "9": "num_nine"
}
```

## 실행 방법
### A) config.json 사용(권장)
```
cd mm_ex1/tools/mm-reaction-cli
node add-reactions.js
```
- `config.json` 값 기준으로 실행됩니다.

### B) 인자/환경변수로 직접 실행
```
node add-reactions.js --base https://your-mm --token <TOKEN> --post <POST_ID> --seq 0105092645 --delay 80
```
또는
```
MM_BASE_URL=https://your-mm MM_TOKEN=<TOKEN> POST_ID=<POST_ID> SEQ=0105 node add-reactions.js
```

임의 이모지 시퀀스를 바로 넘기려면:
```
node add-reactions.js --base https://your-mm --token <TOKEN> --post <POST_ID> --emojis ":thumbsup:,my_custom_1,heart"
```
또는 파일로:
```
node add-reactions.js --base https://your-mm --token <TOKEN> --post <POST_ID> --emojisFile emojis.txt
```

## 사용 팁
- API에는 `emoji_name`에 `:name:`이 아닌 `name`만 보냅니다.
- 중복 반응은 무시되도록 처리되어 있습니다.
- 서버에 레이트 리밋이 켜져 있으면 `delayMs`를 늘리세요.
- 콜론 포함 시퀀스도 지원: `":thumbsup::heart::my_custom:"`
 - 이모지 지정 우선순위:
   1) `config.emojis` 배열
   2) `--emojisFile` 또는 `config.emojisFile`
   3) `--emojis` 인자(또는 `EMOJIS` 환경변수)
   4) 마지막으로 `seq`
