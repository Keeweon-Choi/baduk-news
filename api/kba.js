// =========================================================================
//  Vercel 서버리스 함수 : 한국기원 기보 자동 찾기 (KBA resolver)
//  ---------------------------------------------------------------------
//  뉴스 기사의 '선수명 + 날짜 + 제목'을 받아, 한국기원 기보 목록에서
//  가장 잘 맞는 대국을 찾아 SGF 주소와 신뢰도를 돌려줍니다.
//
//  ▶ 비개발자는 이 파일을 건드릴 필요가 없습니다.
//
//  동작:  /api/kba?player=신진서&date=2026-07-21&title=<기사제목>
//    1) 한국기원 목록을 선수명으로 검색(서버사이드)
//    2) 각 대국을 날짜근접·상대선수·기전 일치로 점수화
//    3) { best, candidates } (JSON) 반환  → 프런트가 SGF를 열어 재생
//
//  ※ 공개·비인증 페이지만 사용하고, 클릭 시에만 1회 요청합니다(전체 미러링 아님).
//    표시할 때는 반드시 출처(한국기원)를 함께 보여주세요.
// =========================================================================

// 한국기원 기보 목록 페이지(최근 프로대국 보드). 사이트가 바뀌면 이 값 점검 필요.
const KBA_URL = "https://www.baduk.or.kr/gibo/gibo_in.asp?game_num=461";

module.exports = async (req, res) => {
  const player = (req.query.player || "").trim();   // 한글 선수명 (예: 신진서)
  const title  = (req.query.title  || "").trim();   // 기사 제목
  const date   = (req.query.date   || "").trim();   // 기사 날짜 YYYY-MM-DD

  if (!player) { res.status(400).json({ error: "player 파라미터가 필요합니다." }); return; }

  try {
    // (1) 한국기원 목록을 '선수명(keyWord)'으로 검색합니다. (pageChange가 쓰는 POST 방식 그대로)
    const body = new URLSearchParams({
      pageNo: "1", keyColumn: "", keyWord: player, etcKey: "", etcKey2: "", etcKey3: ""
    }).toString();
    const r = await fetch(KBA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (BadukNewsDashboard)"
      },
      body,
      signal: AbortSignal.timeout(12000)
    });
    const html = await r.text();

    // (2) 결과 표의 각 행에서 [날짜·기전·흑·백·결과·SGF주소]를 뽑습니다.
    const games = parseKbaRows(html);

    // (3) 기사 정보와 비교해 점수를 매기고 정렬합니다.
    const scored = games
      .map(g => ({ ...g, score: scoreGame(g, { player, title, date }), label: makeLabel(g) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0] && scored[0].score >= 0.7 ? scored[0] : null;

    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1200");
    res.status(200).json({
      best,
      candidates: scored.slice(0, 5),   // 애매하면 프런트가 이 목록을 보여줌
      source: "한국기원(baduk.or.kr)"
    });
  } catch (e) {
    res.status(502).json({ error: "한국기원 조회 실패: " + (e && e.message ? e.message : e) });
  }
};

// 결과 HTML에서 대국 행들을 구조화합니다.
function parseKbaRows(html) {
  const games = [];
  for (const row of html.split("<tr>").slice(1)) {
    if (!row.includes("gibo_load_new")) continue;
    const sgf = row.match(/gibo_load_new\('([^']+)'/);
    if (!sgf) continue;
    // 각 칸(<td>)의 순수 텍스트만 추출
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map(m => m[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim())
      .filter(Boolean);
    // 날짜 칸을 기준으로 그 뒤 [기전, 흑, 백, 결과] 순서로 읽습니다.
    const di = cells.findIndex(c => /^\d{4}-\d{2}-\d{2}/.test(c));
    if (di < 0) continue;
    games.push({
      date:       cells[di],
      tournament: cells[di + 1] || "",
      black:      cells[di + 2] || "",
      white:      cells[di + 3] || "",
      result:     cells[di + 4] || "",
      sgfUrl:     sgf[1]
    });
  }
  return games;
}

// 화면에 보일 대국 이름을 만듭니다.
function makeLabel(g) {
  return `${g.tournament} · ${g.black} vs ${g.white} (${g.date})`;
}

// 기사와 대국이 얼마나 맞는지 0~1 점수로 계산합니다.
function scoreGame(g, { player, title, date }) {
  let s = 0.1;                                   // 선수명 검색으로 이미 걸러졌으므로 기본점

  // (a) 상대 선수가 기사 제목에 있으면 강한 신호
  if (title) {
    const other = title.includes(g.black) ? g.white : g.black;
    if (other && title.includes(other)) s += 0.35;
  }

  // (b) 기전명 토큰이 제목에 있으면 가점
  if (title && g.tournament) {
    const hit = g.tournament.split(/[\s·\-]+/).some(tok => tok.length >= 2 && title.includes(tok));
    if (hit) s += 0.2;
  }

  // (c) 날짜 근접 (기사 날짜와 대국 날짜 차이)
  if (date && /^\d{4}-\d{2}-\d{2}/.test(g.date)) {
    const diff = Math.abs((Date.parse(g.date) - Date.parse(date)) / 86400000);
    if (diff <= 1) s += 0.4;
    else if (diff <= 2) s += 0.25;
    else if (diff <= 3) s += 0.15;
    else if (diff <= 7) s += 0.05;
  }

  return Math.min(1, s);
}
