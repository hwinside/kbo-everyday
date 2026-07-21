# 기사 WebView 댓글 오버레이

## 목표

- 네이티브 앱에서 뉴스 원문을 앱 소유 WebView로 연다.
- 기사 하단의 댓글 바를 누르면 원문 위에 기존 크보팬 `CommentSheet`를 겹쳐 표시한다.
- 기사 본문은 추출·저장·변형하지 않고 원문 URL을 그대로 렌더한다.

## 범위

- iOS: `WKWebView` 기반 전체화면 기사 브라우저.
- Android: `WebView` 기반 전체화면 기사 브라우저.
- 댓글 UI: `keubo.fan/native/news-comments`를 별도 투명 WebView에 로드하고 기존 기사 댓글 API와 `CommentSheet`를 재사용한다.
- 호환 모드: 사이트 오류·로그인·팝업 문제 시 iOS `SFSafariViewController`, Android Custom Tab으로 전환할 수 있다.
- 기존 앱/웹: 새 네이티브 플러그인이 없으면 현재 `@capacitor/browser`/새 탭 동작으로 자동 폴백한다.

## 공개 게이트

- 기사 댓글 API와 카드 UI의 기존 관리자 전용 게이트를 유지한다.
- 자체 WebView는 모든 네이티브 앱 사용자에게 적용하되, 댓글 URL·댓글 바는 관리자에게만 전달한다.
- 일반 공개는 별도 승인과 양 플랫폼 실기기 End-User QA 전까지 금지한다.

## 보안·호환성

- 기사 URL은 `http`/`https`만 허용한다.
- 댓글 WebView URL은 `https://keubo.fan/native/news-comments`만 허용한다.
- 외부 기사 WebView에는 네이티브 JavaScript 인터페이스를 주입하지 않는다.
- 댓글 WebView만 닫기·댓글수 갱신 메시지를 네이티브에 전달한다.
- iOS/Android의 기본 영구 웹 데이터 저장소를 사용해 기존 `keubo.fan` 로그인 쿠키를 공유한다.

## 완료 기준

- 기사 탭 → 자체 WebView 원문 로드.
- 관리자: 댓글 바 → 반높이 댓글시트 → 작성·삭제·신고 동작, 입력 탭이 기사 내비게이션을 유발하지 않음.
- 일반 사용자: 댓글 바·댓글 WebView·discussion API 호출이 없음.
- 호환 모드 전환과 네이티브 뒤로가기/닫기가 동작함.
- TypeScript, 기사 댓글 회귀, Android 빌드, iOS simulator 빌드가 통과함.

