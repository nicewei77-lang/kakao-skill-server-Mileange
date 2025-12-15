// index.js
const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');

const app = express();
app.use(express.json());

// ======================================
// 1. Google Sheets 공통 설정
// ======================================

// ─ 본인인증용 명단 시트 ─
const AUTH_SPREADSHEET_ID = '1F_pq-dE_oAi_nJRThSjP5-QA-c8mmzJ5hA5mSbJXH60';
const AUTH_RANGE = "'시트1'!A4:S200";

// ─ 포인트 시트 ─
const POINTS_SPREADSHEET_ID = '1ujB1ZLjmXZXmkQREINW7YojdoXEYBN7gUlXCVTNUswM';
const POINTS_RANGE = "'마일링지'!A2:AF200";

// ─ 본인인증용 명단 시트 내 열 인덱스 (0-based, A=0, B=1, C=2, ...) ─
const COL_STAFF_NAME = 2;    // C열: 스태프 이름
const COL_STAFF_PHONE = 8;    // I열: 스태프 연락처
const COL_MEMBER_NAME = 11;   // L열: 멤버 이름
const COL_MEMBER_PHONE = 17;  // R열: 멤버 전화번호

// ─ 포인트 시트 내 열 인덱스 (0-based) ─
const COL_POINTS_NAME = 1;    // B열: 이름
const COL_POINTS_TOTAL = 31;  // AF열: 마일리지 총 합

// ======================================
// 2. Google Sheets 클라이언트
// ======================================

function createSheetsClient() {
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!rawKey) {
    throw new Error('환경변수 GOOGLE_SERVICE_ACCOUNT_KEY 가 설정되어 있지 않습니다.');
  }

  const credentials = JSON.parse(rawKey);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  return google.sheets({ version: 'v4', auth });
}

// ======================================
// 3. 유틸리티 함수
// ======================================

/**
 * 전화번호에서 뒤 4자리 추출
 */
function extractLast4Digits(phone) {
  const digits = (phone || '').toString().replace(/[^0-9]/g, '');
  return digits.slice(-4);
}

/**
 * 카카오 응답 포맷 생성
 */
function createKakaoResponse(text, quickReplies = null) {
  const response = {
    version: '2.0',
    template: {
      outputs: [
        {
          simpleText: { text },
        },
      ],
    },
  };

  if (quickReplies) {
    response.template.quickReplies = quickReplies;
  }

  return response;
}

/**
 * 콜백 모드 응답 생성 (즉시 반환용)
 */
function createCallbackResponse(data = null) {
  const response = {
    version: '2.0',
    useCallback: true,
  };
  
  if (data) {
    response.data = data;
  }
  
  return response;
}

/**
 * callbackUrl로 최종 응답 전송
 */
async function sendCallbackResponse(callbackUrl, text, quickReplies = null) {
  try {
    const response = createKakaoResponse(text, quickReplies);
    await axios.post(callbackUrl, response, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000, // 10초 타임아웃
    });
    console.log('콜백 응답 전송 성공:', callbackUrl);
  } catch (err) {
    console.error('콜백 응답 전송 실패:', err.message);
    throw err;
  }
}

/**
 * 포인트 값 파싱
 */
function parsePointsValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isNaN(num) ? null : num;
}

// ======================================
// 4. 본인인증: 이름 + 전화 뒤 4자리 찾기
// ======================================

async function findPersonByNameAndPhone4(name, phone4) {
  const sheets = createSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: AUTH_SPREADSHEET_ID,
    range: AUTH_RANGE,
  });

  const rows = res.data.values || [];
  if (!rows.length) return null;

  const targetName = (name || '').trim();
  const targetPhone4 = (phone4 || '').trim();

  for (const row of rows) {
    // 멤버 확인
    const memberName = (row[COL_MEMBER_NAME] || '').trim();
    const memberPhone = row[COL_MEMBER_PHONE];
    const memberLast4 = extractLast4Digits(memberPhone);

    if (
      memberName &&
      memberLast4 &&
      memberLast4 === targetPhone4 &&
      memberName === targetName
    ) {
      return {
        role: '멤버',
        name: memberName,
        phone4: memberLast4,
      };
    }

    // 스태프 확인
    const staffName = (row[COL_STAFF_NAME] || '').trim();
    const staffPhone = row[COL_STAFF_PHONE];
    const staffLast4 = extractLast4Digits(staffPhone);

    if (
      staffName &&
      staffLast4 &&
      staffLast4 === targetPhone4 &&
      staffName === targetName
    ) {
      return {
        role: '스태프',
        name: staffName,
        phone4: staffLast4,
      };
    }
  }

  return null;
}

// ======================================
// 5. 포인트 조회: 이름으로 포인트 찾기
// ======================================

async function findPointsByName(name) {
  const sheets = createSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: POINTS_SPREADSHEET_ID,
    range: POINTS_RANGE,
  });

  const rows = res.data.values || [];
  if (!rows.length) return null;

  const targetName = (name || '').trim();

  for (const row of rows) {
    const rowName = (row[COL_POINTS_NAME] || '').trim();
    if (!rowName || rowName !== targetName) continue;

    const pointsValue = row[COL_POINTS_TOTAL];
    const points = parsePointsValue(pointsValue);

    return {
      name: rowName,
      points: points,
    };
  }

  return null;
}

// ======================================
// 6. 세션 관리
// ======================================

// key: kakao user id, value: { name, role, phone4 }
const lastAuthByUserId = new Map();

// ======================================
// 7. Kakao 스킬 - 본인인증 (/kakao)
// ======================================

app.post('/kakao', async (req, res) => {
  try {
    const { action = {}, userRequest = {} } = req.body;
    const { params = {} } = action;
    const { user = {} } = userRequest;
    const kakaoUserId = user.id || null;
    const callbackUrl = userRequest.callbackUrl; // 콜백 URL 확인

    const userName = params.user_name || '';
    const userPhone4 = params.user_phone4 || '';

    console.log('인증 요청 - 이름:', userName, '전화 뒤 4자리:', userPhone4);
    console.log('콜백 모드:', callbackUrl ? '활성화' : '비활성화');

    // 입력값 검증
    if (!userName || !userPhone4) {
      const errorMsg = '이름과 전화번호 뒤 4자리를 모두 입력해야 본인인증이 가능합니다.\n다시 시도해주세요.';
      
      // 콜백 모드면 즉시 응답 후 콜백으로 에러 전송
      if (callbackUrl) {
        res.json(createCallbackResponse({
          text: '처리 중입니다...'
        }));
        try {
          await sendCallbackResponse(callbackUrl, errorMsg);
        } catch (err) {
          console.error('콜백 에러 전송 실패:', err);
        }
        return;
      }
      
      return res.json(createKakaoResponse(errorMsg));
    }

    // 콜백 모드인 경우 즉시 응답
    if (callbackUrl) {
      res.json(createCallbackResponse({
        text: '본인인증 처리 중입니다...\n잠시만 기다려주세요.'
      }));
      
      // 백그라운드에서 실제 처리
      (async () => {
        try {
          // 본인인증 처리
          const person = await findPersonByNameAndPhone4(userName, userPhone4);

          if (!person) {
            await sendCallbackResponse(
              callbackUrl,
              '입력하신 정보와 일치하는 인원을 찾지 못했습니다.\n이름과 전화번호 뒤 4자리를 다시 한 번 확인해주세요.\n(그래도 안 되면 운영진에게 문의해주세요.)'
            );
            return;
          }

          // 세션에 인증정보 저장
          if (kakaoUserId) {
            lastAuthByUserId.set(kakaoUserId, {
              name: person.name,
              role: person.role,
              phone4: person.phone4,
            });
          }

          // 성공 응답
          const msg = [
            `${person.name}님, 본인인증이 완료되었습니다 ✅`,
            '',
            '이제 아래 버튼을 눌러 포인트를 확인할 수 있습니다.',
          ].join('\n');

          await sendCallbackResponse(callbackUrl, msg, [
            {
              label: '포인트 조회',
              action: 'message',
              messageText: '#포인트_조회',
            },
          ]);
        } catch (err) {
          console.error('콜백 처리 중 오류:', err);
          try {
            await sendCallbackResponse(
              callbackUrl,
              '본인인증 처리 중 내부 오류가 발생했습니다.\n잠시 후 다시 시도해 주세요.\n(지속되면 운영진에게 문의해주세요.)'
            );
          } catch (callbackErr) {
            console.error('콜백 에러 전송 실패:', callbackErr);
          }
        }
      })();
      
      return;
    }

    // 일반 모드 (기존 로직)
    const person = await findPersonByNameAndPhone4(userName, userPhone4);

    if (!person) {
      return res.json(
        createKakaoResponse(
          '입력하신 정보와 일치하는 인원을 찾지 못했습니다.\n이름과 전화번호 뒤 4자리를 다시 한 번 확인해주세요.\n(그래도 안 되면 운영진에게 문의해주세요.)'
        )
      );
    }

    // 세션에 인증정보 저장
    if (kakaoUserId) {
      lastAuthByUserId.set(kakaoUserId, {
        name: person.name,
        role: person.role,
        phone4: person.phone4,
      });
    }

    // 성공 응답
    const msg = [
      `${person.name}님, 본인인증이 완료되었습니다 ✅`,
      '',
      '이제 아래 버튼을 눌러 포인트를 확인할 수 있습니다.',
    ].join('\n');

    return res.json(
      createKakaoResponse(msg, [
        {
          label: '포인트 조회',
          action: 'message',
          messageText: '#포인트_조회',
        },
      ])
    );
  } catch (err) {
    console.error('본인인증 처리 중 오류:', err);
    
    // 콜백 모드면 에러도 콜백으로 전송
    const callbackUrl = req.body?.userRequest?.callbackUrl;
    if (callbackUrl) {
      res.json(createCallbackResponse({
        text: '처리 중입니다...'
      }));
      try {
        await sendCallbackResponse(
          callbackUrl,
          '본인인증 처리 중 내부 오류가 발생했습니다.\n잠시 후 다시 시도해 주세요.\n(지속되면 운영진에게 문의해주세요.)'
        );
      } catch (callbackErr) {
        console.error('콜백 에러 전송 실패:', callbackErr);
      }
      return;
    }
    
    return res.json(
      createKakaoResponse(
        '본인인증 처리 중 내부 오류가 발생했습니다.\n잠시 후 다시 시도해 주세요.\n(지속되면 운영진에게 문의해주세요.)'
      )
    );
  }
});

// ======================================
// 8. Kakao 스킬 - 포인트 조회 (/points)
// ======================================

app.post('/points', async (req, res) => {
  try {
    const { userRequest = {} } = req.body;
    const { user = {} } = userRequest;
    const kakaoUserId = user.id || null;
    const callbackUrl = userRequest.callbackUrl; // 콜백 URL 확인

    console.log('포인트 조회 요청 - 콜백 모드:', callbackUrl ? '활성화' : '비활성화');

    // 사용자 정보 확인
    if (!kakaoUserId) {
      const errorMsg = '사용자 정보를 확인할 수 없습니다.\n다시 시도해 주세요.';
      
      if (callbackUrl) {
        res.json(createCallbackResponse({
          text: '처리 중입니다...'
        }));
        try {
          await sendCallbackResponse(callbackUrl, errorMsg);
        } catch (err) {
          console.error('콜백 에러 전송 실패:', err);
        }
        return;
      }
      
      return res.json(createKakaoResponse(errorMsg));
    }

    // 본인인증 세션 확인
    const session = lastAuthByUserId.get(kakaoUserId);
    if (!session || !session.name) {
      const errorMsg = '먼저 본인인증이 필요합니다.\n포인트 조회 메뉴에서 [본인확인]을 다시 진행해 주세요.';
      
      if (callbackUrl) {
        res.json(createCallbackResponse({
          text: '처리 중입니다...'
        }));
        try {
          await sendCallbackResponse(callbackUrl, errorMsg);
        } catch (err) {
          console.error('콜백 에러 전송 실패:', err);
        }
        return;
      }
      
      return res.json(createKakaoResponse(errorMsg));
    }

    // 콜백 모드인 경우 즉시 응답
    if (callbackUrl) {
      res.json(createCallbackResponse({
        text: '포인트 조회 중입니다...\n잠시만 기다려주세요.'
      }));
      
      // 백그라운드에서 실제 처리
      (async () => {
        try {
          // 포인트 정보 조회
          const pointsData = await findPointsByName(session.name);

          if (!pointsData || pointsData.points === null) {
            await sendCallbackResponse(
              callbackUrl,
              `${session.name}님의 포인트 정보를 찾지 못했습니다.\n운영진에게 포인트 등록 여부를 확인해 주세요.`
            );
            return;
          }

          // 성공 응답
          const msg = [
            `${session.name}님의 마일리지 현황입니다.`,
            '',
            `현재 마일리지: ${pointsData.points.toLocaleString()}점`,
          ].join('\n');

          await sendCallbackResponse(callbackUrl, msg);
        } catch (err) {
          console.error('콜백 처리 중 오류:', err);
          try {
            await sendCallbackResponse(
              callbackUrl,
              '포인트 조회 중 내부 오류가 발생했습니다.\n잠시 후 다시 시도해 주세요.\n(지속되면 운영진에게 문의해주세요.)'
            );
          } catch (callbackErr) {
            console.error('콜백 에러 전송 실패:', callbackErr);
          }
        }
      })();
      
      return;
    }

    // 일반 모드 (기존 로직)
    const pointsData = await findPointsByName(session.name);

    if (!pointsData || pointsData.points === null) {
      return res.json(
        createKakaoResponse(
          `${session.name}님의 포인트 정보를 찾지 못했습니다.\n운영진에게 포인트 등록 여부를 확인해 주세요.`
        )
      );
    }

    // 성공 응답
    const msg = [
      `${session.name}님의 마일리지 현황입니다.`,
      '',
      `현재 마일리지: ${pointsData.points.toLocaleString()}점`,
    ].join('\n');

    return res.json(createKakaoResponse(msg));
  } catch (err) {
    console.error('포인트 조회 중 오류:', err);
    
    // 콜백 모드면 에러도 콜백으로 전송
    const callbackUrl = req.body?.userRequest?.callbackUrl;
    if (callbackUrl) {
      res.json(createCallbackResponse({
        text: '처리 중입니다...'
      }));
      try {
        await sendCallbackResponse(
          callbackUrl,
          '포인트 조회 중 내부 오류가 발생했습니다.\n잠시 후 다시 시도해 주세요.\n(지속되면 운영진에게 문의해주세요.)'
        );
      } catch (callbackErr) {
        console.error('콜백 에러 전송 실패:', callbackErr);
      }
      return;
    }
    
    return res.json(
      createKakaoResponse(
        '포인트 조회 중 내부 오류가 발생했습니다.\n잠시 후 다시 시도해 주세요.\n(지속되면 운영진에게 문의해주세요.)'
      )
    );
  }
});

// ======================================
// 9. 헬스체크
// ======================================

app.get('/', (req, res) => {
  res.send('Mileage skill server OK');
});

// 카카오 챗봇 빌더 스킬 테스트용 - 루트 경로 POST 요청 처리
app.post('/', async (req, res) => {
  try {
    console.log('루트 경로 POST 요청 수신:', JSON.stringify(req.body, null, 2));
    
    const { action = {}, userRequest = {} } = req.body;
    const { params = {} } = action;
    const { user = {} } = userRequest;
    const kakaoUserId = user.id || null;
    const callbackUrl = userRequest.callbackUrl; // 콜백 URL 확인

    const userName = params.user_name || '';
    const userPhone4 = params.user_phone4 || '';

    console.log('콜백 모드:', callbackUrl ? '활성화' : '비활성화');

    // 테스트 요청인 경우 (파라미터가 없는 경우)
    if (!userName && !userPhone4) {
      const testMsg = '스킬 서버가 정상적으로 작동 중입니다.\n본인인증을 하려면 이름과 전화번호 뒤 4자리를 입력해주세요.';
      
      if (callbackUrl) {
        res.json(createCallbackResponse({
          text: '처리 중입니다...'
        }));
        try {
          await sendCallbackResponse(callbackUrl, testMsg);
        } catch (err) {
          console.error('콜백 에러 전송 실패:', err);
        }
        return;
      }
      
      return res.json(createKakaoResponse(testMsg));
    }

    console.log('인증 요청 - 이름:', userName, '전화 뒤 4자리:', userPhone4);

    // 입력값 검증
    if (!userName || !userPhone4) {
      const errorMsg = '이름과 전화번호 뒤 4자리를 모두 입력해야 본인인증이 가능합니다.\n다시 시도해주세요.';
      
      if (callbackUrl) {
        res.json(createCallbackResponse({
          text: '처리 중입니다...'
        }));
        try {
          await sendCallbackResponse(callbackUrl, errorMsg);
        } catch (err) {
          console.error('콜백 에러 전송 실패:', err);
        }
        return;
      }
      
      return res.json(createKakaoResponse(errorMsg));
    }

    // 콜백 모드인 경우 즉시 응답
    if (callbackUrl) {
      res.json(createCallbackResponse({
        text: '본인인증 처리 중입니다...\n잠시만 기다려주세요.'
      }));
      
      // 백그라운드에서 실제 처리
      (async () => {
        try {
          // 본인인증 처리
          const person = await findPersonByNameAndPhone4(userName, userPhone4);

          if (!person) {
            await sendCallbackResponse(
              callbackUrl,
              '입력하신 정보와 일치하는 인원을 찾지 못했습니다.\n이름과 전화번호 뒤 4자리를 다시 한 번 확인해주세요.\n(그래도 안 되면 운영진에게 문의해주세요.)'
            );
            return;
          }

          // 세션에 인증정보 저장
          if (kakaoUserId) {
            lastAuthByUserId.set(kakaoUserId, {
              name: person.name,
              role: person.role,
              phone4: person.phone4,
            });
          }

          // 성공 응답
          const msg = [
            `${person.name}님, 본인인증이 완료되었습니다 ✅`,
            '',
            '이제 아래 버튼을 눌러 포인트를 확인할 수 있습니다.',
          ].join('\n');

          await sendCallbackResponse(callbackUrl, msg, [
            {
              label: '포인트 조회',
              action: 'message',
              messageText: '#포인트_조회',
            },
          ]);
        } catch (err) {
          console.error('콜백 처리 중 오류:', err);
          try {
            await sendCallbackResponse(
              callbackUrl,
              '본인인증 처리 중 내부 오류가 발생했습니다.\n잠시 후 다시 시도해 주세요.\n(지속되면 운영진에게 문의해주세요.)'
            );
          } catch (callbackErr) {
            console.error('콜백 에러 전송 실패:', callbackErr);
          }
        }
      })();
      
      return;
    }

    // 일반 모드 (기존 로직)
    const person = await findPersonByNameAndPhone4(userName, userPhone4);

    if (!person) {
      return res.json(
        createKakaoResponse(
          '입력하신 정보와 일치하는 인원을 찾지 못했습니다.\n이름과 전화번호 뒤 4자리를 다시 한 번 확인해주세요.\n(그래도 안 되면 운영진에게 문의해주세요.)'
        )
      );
    }

    // 세션에 인증정보 저장
    if (kakaoUserId) {
      lastAuthByUserId.set(kakaoUserId, {
        name: person.name,
        role: person.role,
        phone4: person.phone4,
      });
    }

    // 성공 응답
    const msg = [
      `${person.name}님, 본인인증이 완료되었습니다 ✅`,
      '',
      '이제 아래 버튼을 눌러 포인트를 확인할 수 있습니다.',
    ].join('\n');

    return res.json(
      createKakaoResponse(msg, [
        {
          label: '포인트 조회',
          action: 'message',
          messageText: '#포인트_조회',
        },
      ])
    );
  } catch (err) {
    console.error('루트 경로 처리 중 오류:', err);
    
    // 콜백 모드면 에러도 콜백으로 전송
    const callbackUrl = req.body?.userRequest?.callbackUrl;
    if (callbackUrl) {
      res.json(createCallbackResponse({
        text: '처리 중입니다...'
      }));
      try {
        await sendCallbackResponse(
          callbackUrl,
          '스킬 서버 처리 중 내부 오류가 발생했습니다.\n잠시 후 다시 시도해 주세요.\n(지속되면 운영진에게 문의해주세요.)'
        );
      } catch (callbackErr) {
        console.error('콜백 에러 전송 실패:', callbackErr);
      }
      return;
    }
    
    return res.json(
      createKakaoResponse(
        '스킬 서버 처리 중 내부 오류가 발생했습니다.\n잠시 후 다시 시도해 주세요.\n(지속되면 운영진에게 문의해주세요.)'
      )
    );
  }
});

// ======================================
// 10. 서버 시작
// ======================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log('AUTH_RANGE =', AUTH_RANGE);
  console.log('POINTS_RANGE =', POINTS_RANGE);
});
