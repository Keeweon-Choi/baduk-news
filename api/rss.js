// =========================================================================
//  Vercel 서버리스 함수 (프록시)
//  ---------------------------------------------------------------------
//  브라우저는 보안(CORS) 때문에 다른 사이트의 RSS를 직접 못 가져옵니다.
//  그래서 '서버'가 대신 가져와 돌려주는 이 함수를 둡니다.
//  공개 프록시(allorigins 등)보다 훨씬 빠르고 안정적입니다.
//
//  ▶ 비개발자는 이 파일을 건드릴 필요가 없습니다.
//    (보여줄 뉴스 목록은 index.html 맨 위의 SOURCES에서 관리합니다.)
//
//  동작: 브라우저가  /api/rss?url=<RSS주소>  로 요청하면,
//        이 함수가 그 주소의 내용을 가져와 그대로 돌려줍니다.
// =========================================================================
module.exports = async (req, res) => {
  const target = req.query.url;

  // url 값이 없으면 안내만 하고 끝냅니다.
  if (!target) {
    res.status(400).send("url 파라미터가 필요합니다. 예: /api/rss?url=https://...");
    return;
  }

  try {
    // 서버가 직접 RSS 주소로 접속해 내용을 받아옵니다. (12초 안에 응답 없으면 포기)
    const r = await fetch(target, {
      headers: { "User-Agent": "Mozilla/5.0 (BadukNewsDashboard)" },
      signal: AbortSignal.timeout(12000),
    });
    const text = await r.text();

    // 받아온 내용을 브라우저에 돌려줍니다.
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    // 같은 요청은 5분간 캐시해서 반복 접속을 더 빠르게 합니다.
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).send(text);
  } catch (e) {
    // 실패하면 브라우저가 다른 백업 프록시로 넘어갈 수 있도록 오류 코드를 돌려줍니다.
    res.status(502).send("가져오기 실패: " + (e && e.message ? e.message : e));
  }
};
