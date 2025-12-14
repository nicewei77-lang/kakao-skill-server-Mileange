# 📘 Mileage Point Chatbot Skill Server

카카오 챗봇에서 본인인증 + 포인트 조회 자동화를 제공하는 Node.js 기반 스킬 서버입니다.
Google Sheets 데이터를 기반으로 멤버/스태프 본인인증 후 **마일리지 현황**을 조회할 수 있습니다.

⸻

## ✨ 주요 기능

### 🔐 1. 본인인증
- 이름 + 전화번호 뒤 4자리로 신원 확인
- 스태프/멤버 자동 구분
- Google Sheets 명단 시트에서 정확한 행 조회
- 카카오 User ID 기반 세션 유지 (인증 1회 → 이후 바로 포인트 조회 가능)
- 인증 완료 후 즉시 포인트 조회 버튼 제공

### 📊 2. 실시간 포인트 조회
- 포인트 시트에서 사용자 검색 (B열: 이름)
- 마일리지 총 합 조회 (AF열: 마일리지 총 합)
- 숫자 포맷팅 (천 단위 구분)

⸻

## 🔑 Google 서비스 계정 설정 및 시트 공유 (필수!)

### 서비스 계정 생성 및 키 다운로드

1. [Google Cloud Console](https://console.cloud.google.com/) 접속
2. 프로젝트 생성 또는 기존 프로젝트 선택
3. **API 및 서비스** > **사용자 인증 정보** 이동
4. **사용자 인증 정보 만들기** > **서비스 계정** 선택
5. 서비스 계정 생성 후 **키** 탭에서 **키 추가** > **JSON** 선택
6. 다운로드된 JSON 파일의 내용을 복사 (이것이 `GOOGLE_SERVICE_ACCOUNT_KEY` 값)

### 서비스 계정 이메일 확인

다운로드한 JSON 파일에서 `client_email` 필드를 확인합니다:
```json
{
  "type": "service_account",
  "project_id": "...",
  "private_key_id": "...",
  "private_key": "...",
  "client_email": "your-service-account@project-id.iam.gserviceaccount.com",
  ...
}
```

**이 `client_email` 값이 서비스 계정의 이메일 주소입니다.**

### Google Sheets에 서비스 계정 공유 방법

**본인인증용 시트와 포인트 시트 모두에 공유해야 합니다:**

1. 각 Google Sheets 파일을 열기
2. 우측 상단 **공유** 버튼 클릭
3. 서비스 계정의 이메일 주소(`client_email` 값)를 입력
4. 권한은 **뷰어** 선택 (읽기 전용)
5. **완료** 클릭

⚠️ **주의**: 서비스 계정 이메일을 공유하지 않으면 API 접근이 거부되어 오류가 발생합니다!

⸻

## 🗂 Google Sheets 구조

### 🔹 1. 본인인증용 명단 시트

- **시트 이름**: `시트1`
- **데이터 범위**: `'시트1'!A4:S200`
- **열 구조**:
  - C열: 스태프 이름
  - I열: 스태프 전화번호
  - L열: 멤버 이름
  - R열: 멤버 전화번호

### 🔹 2. 포인트 시트

- **시트 이름**: `마일링지`
- **데이터 범위**: `'마일링지'!A2:AF200` (이름과 마일리지 포함)
- **열 구조**:
  - **B열**: 이름
  - **AF열**: 마일리지 총 합

⸻

## ⚙️ 서버 구조

```
index.js
├── Express 서버
├── /kakao (본인인증)
├── /points (포인트 조회)
├── Google Sheets API client
├── findPersonByNameAndPhone4() (본인인증)
├── findPointsByName() (포인트 조회)
└── 세션 관리 Map(lastAuthByUserId)
```

⸻

## 🌐 API 엔드포인트

### ▶ POST /kakao
- 카카오 스킬 서버가 본인인증 요청 시 호출
- 성공 시 QuickReplies로 포인트 조회 버튼을 반환

### ▶ POST /points
- 본인 인증된 사용자만 조회 허용
- 마일리지 정보 문자열 반환
- 카카오 챗봇 응답 포맷 100% 준수

⸻

## 🔧 환경 변수

```
PORT=3000
GOOGLE_SERVICE_ACCOUNT_KEY={서비스 계정 JSON 전체}
```

**GOOGLE_SERVICE_ACCOUNT_KEY 설정 방법:**
1. 서비스 계정 JSON 파일의 전체 내용을 복사
2. Render의 Environment Variables에 그대로 붙여넣기
3. 줄바꿈 문자가 있어도 문제 없음 (Render가 자동 처리)

**주의**: JSON 전체를 한 줄로 붙여넣거나, 여러 줄로 붙여넣어도 됩니다.

⸻

## 🚀 배포 과정 (Render 기준)

1. GitHub 저장소 연결
2. Build Command: `npm install`
3. Start Command: `node index.js`
4. Environment Variables에 `GOOGLE_SERVICE_ACCOUNT_KEY` 입력
5. Deploy
6. Render가 HTTPS 도메인을 생성 → 카카오 스킬 URL로 사용

⸻

## 📡 카카오 챗봇 설정

### 📌 스킬 URL

(예: Render 도메인이 `https://mileage-skill.onrender.com`라면)

- **본인인증**: `https://mileage-skill.onrender.com/kakao`
- **포인트 조회**: `https://mileage-skill.onrender.com/points`

### 📌 포인트 조회 블록 패턴

본인인증 성공 후 반환되는 메시지 텍스트:
```
#포인트_조회
```

이 문자열이 카카오 시나리오의 포인트 조회 블록 트리거입니다. (필요시 수정)

⸻

## ⚠️ 개발 전 필수 설정

`index.js` 파일에서 다음 정보를 반드시 설정해야 합니다:

1. **AUTH_SPREADSHEET_ID**: 본인인증용 시트 ID
2. **AUTH_RANGE**: 본인인증 시트 범위
3. **POINTS_SPREADSHEET_ID**: 포인트 시트 ID
4. **POINTS_RANGE**: 포인트 시트 범위
5. **열 인덱스**: 실제 시트 구조에 맞게 수정
   - `COL_STAFF_NAME`, `COL_STAFF_PHONE`, `COL_MEMBER_NAME`, `COL_MEMBER_PHONE`
   - `COL_POINTS_NAME`, `COL_POINTS_TOTAL`

⸻

## 📝 TODO

- [ ] 카카오 시나리오 블록 패턴 확인 및 메시지 텍스트 수정 (`#포인트_조회`)
