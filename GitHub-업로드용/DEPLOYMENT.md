# 수정본 배포 안내

## 무엇을 올리나요?

- `hackathon-cloudflare-design.zip`: Cloudflare Pages에 직접 올리는 배포 파일입니다. ZIP을 풀거나 소스 ZIP을 배포하지 마세요.
- `hackathon-source-design.zip`: 수정한 소스와 테스트의 보관용입니다.
- 배포 ZIP은 화면과 API Worker만 포함합니다. 실제 키, 로컬 계정 DB, 비밀값은 포함하지 않습니다.

## 기존 Pages 프로젝트 업데이트

1. 기존 `rode-hackathon` Pages 프로젝트를 엽니다. 새 프로젝트를 만들 필요는 없습니다.
2. 실제 사이트에 쓰는 배포 환경의 Settings → Variables and Secrets에서 기존 `DATA_GO_KR_SERVICE_KEY`를 유지합니다. 이 키는 관광지·식당·TAGO 교통편에 쓰입니다. 서비스별 활용신청 승인은 별개입니다.
3. 차량·시내버스·지하철 경로 조회에는 `KAKAO_REST_API_KEY`가 필요합니다. 카카오 개발자 사이트의 해당 앱에서 발급한 REST API 키를 Cloudflare Secret(Encrypt)으로 등록하세요. JavaScript 키가 아닙니다. 대중교통은 카카오맵 사용 설정도 확인하세요. 키를 채팅·GitHub·공개 파일에 붙여 넣지 마세요.
4. 설정 저장 후 새 배포를 만들어 `hackathon-cloudflare-design.zip`을 업로드합니다. 새 Secret은 새 배포에 반영되므로 설정만 저장하고 끝내지 마세요. 기존 Secret 값을 지우거나 소스에 입력할 필요는 없습니다.
5. 배포 완료 후 페이지를 새로고침하고 이동 카드에서 지하철·시내버스·차량을 각각 선택해 ‘예상시간’ 조회를 펼쳐 보세요. 오류 문구가 키 없음에서 인증·권한 오류로 바뀐다면 해당 서비스 설정·승인을 별도로 확인해야 합니다. 키 추가만으로 모든 경로 조회 성공이 보장되지는 않습니다.

## 계정 저장은 선택 사항

직접 여행 계획서를 편집하는 기능과 계정 저장은 별개입니다. 로그인·다른 기기 저장을 쓸 때만 D1 DB, `DB` 바인딩, `account-schema.sql` 적용, `AUTH_SECRET`이 필요합니다. 이미 계정 저장을 사용한다면 기존 DB·Secret을 보존하세요. 이를 새로 만들거나 바꾸는 작업은 이번 ZIP 업로드에 포함되지 않습니다.

## 확인할 항목

- 여행지·관광지 생성, 식당 조회, 기차·버스 시간표 조회
- 이동시간 미정(0분) 상태의 메모 저장과 실제 시간 입력
- 카카오 경로 오류 시 지도 링크와 수동 편집 유지
- 이용 안내 링크, 기존 저장 노트 불러오기
- 미정 이동이 남은 일정은 임시 계획입니다. 여객선 등 제공기관 시각이 이상하면 선사·운영기관에 확인하세요. 데이터를 임의로 추정해 고치지 않았습니다.

공식 안내:
- https://developers.cloudflare.com/pages/get-started/direct-upload/
- https://developers.cloudflare.com/pages/functions/bindings/#secrets
- https://developers.kakao.com/docs/ko/kakaomap/rest-api#routing-publictraffic
- https://apis.map.kakao.com/web/guide/#routeurl


## 사진 디자인 버전 확인
기존 기능 수정본을 포함한 별도 디자인 버전입니다. 기존 DATA_GO_KR_SERVICE_KEY를 그대로 사용합니다. 배포 후 /api/tour/backdrop 응답과 첫 화면을 확인하세요. 세 고정 장소의 공공누리 제1유형 사진만 표시하므로 빈 items는 키 오류뿐 아니라 사용 가능한 사진이 없다는 뜻일 수 있습니다. 이 경우에도 일정 편집은 정상 작동하고 기본 종이색 배경을 유지합니다. 사진이 보이지 않는다고 키를 새로 만들거나 공개하지 마세요. 출처와 이용조건은 화면 하단 및 ‘사진 이용 안내’에 표시됩니다.
