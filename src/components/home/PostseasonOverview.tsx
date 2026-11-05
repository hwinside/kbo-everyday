"use client";

import { useEffect, useId, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ChevronRight, Trophy, X } from "lucide-react";
import type { LadderRound, LadderSnapshot } from "@/lib/postseason/ladder";
import { getTeamById } from "@/lib/constants/teams";
import styles from "./PostseasonOverview.module.css";

const states = { waiting: "대진 대기", scheduled: "경기 예정", live: "진행 중", complete: "시리즈 종료", changed: "일정 변경" };
const stageNames: Record<string, string> = { "4": "와일드카드", "3": "준플레이오프", "5": "플레이오프", "7": "한국시리즈" };
const shortNames: Record<string, string> = { "4": "WC", "3": "준PO", "5": "PO", "7": "한국시리즈" };
type Slot = { teamId?: number; name: string; rank?: number; wins?: number };
type Game = LadderRound["games"][number];

function slots(data: LadderSnapshot, round: LadderRound, index: number): Slot[] {
  // Registered matchups are authoritative; never replace them with inferred winners.
  if (round.participants.length) return round.participants.map(p => ({ ...p, rank: data.seeds.find(s => s.teamId === p.teamId)?.rank }));
  const seed = (rank: number): Slot => data.seeds.find(s => s.rank === rank) ?? { name: `${rank}위` };
  return index === 0 ? [seed(5), seed(4)] : [seed([0, 3, 2, 1][index]), { name: `${shortNames[data.rounds[index - 1].id]} 승자` }];
}

function Crest({ teamId, small = false }: { teamId?: number; small?: boolean }) {
  const team = teamId ? getTeamById(teamId) : undefined;
  return <span className={`${styles.crest} ${small ? styles.small : ""} ${!team ? styles.unknown : ""}`} aria-hidden="true">
    {team ? <Image src={team.logoPath} alt="" width={62} height={62} unoptimized /> : "?"}
  </span>;
}

function dateLabel(date: string) {
  const day = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T12:00:00+09:00`);
  return `${date.slice(4, 6)}.${date.slice(6, 8)} ${new Intl.DateTimeFormat("ko-KR", { weekday: "short", timeZone: "Asia/Seoul" }).format(day)}`;
}

function gameState(game: Game) {
  if (game.notNeeded) return "시리즈 종료로 미개최";
  if (game.status === "cancelled") return "취소·재편성 확인 중";
  if (game.status === "live" || game.status === "final") return `${game.awayScore ?? "—"}:${game.homeScore ?? "—"} ${game.status === "live" ? "진행 중" : "종료"}`;
  return "예정";
}

function condition(slot: Slot, round: LadderRound) {
  if (round.winnerId === slot.teamId) return round.id === "7" ? "한국시리즈 우승" : "다음 라운드 진출";
  if (round.state === "complete") return `${slot.wins ?? 0}승 · 시리즈 종료`;
  if (round.id === "4" && slot.rank === 4) return "1승 또는 무승부로 진출";
  if (round.id === "4" && slot.rank === 5) return "2승 하면 진출";
  if (round.id === "4") return "진출 조건 확인 중";
  return `${round.id === "7" ? "4" : "3"}선승제`;
}

function GameRow({ game }: { game: Game }) {
  const content = <><span><b>{game.displayLabel}</b><small>{gameState(game)}</small></span><span>{dateLabel(game.date)} · {game.time}</span>{!game.notNeeded && <ChevronRight size={14} aria-hidden="true" />}</>;
  return <li>{game.notNeeded ? <div className={styles.gameRow}>{content}</div> : <Link className={styles.gameRow} href={`/games/${game.gameId}`}>{content}</Link>}</li>;
}

export default function PostseasonOverview({ data }: { data: LadderSnapshot }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const stageRefs = useRef<(HTMLElement | null)[]>([]);
  const [focusStage, setFocusStage] = useState(0);
  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    element?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    stageRefs.current[focusStage]?.scrollIntoView({ block: "nearest" });
    return () => { element?.close(); document.body.style.overflow = previous; };
  }, [open, focusStage]);

  const round = data.rounds.find(r => r.id === data.currentStage) ?? data.rounds[0];
  const index = data.rounds.indexOf(round);
  const teams = slots(data, round, index);
  const game = round.games.find(g => !g.notNeeded && g.status === "live")
    ?? round.games.find(g => !g.notNeeded && g.status === "scheduled")
    ?? round.games.filter(g => !g.notNeeded).at(-1);
  const otherGames = round.games.filter(g => g.gameId !== game?.gameId);
  const show = (stage = 0) => { setFocusStage(stage); setOpen(true); };
  const hasScore = game && (game.status === "live" || game.status === "final");
  // Hero sides follow the selected game's away/home order so score labels cannot swap.
  const heroTeams = game ? [game.awayTeamId, game.homeTeamId].map(id => teams.find(t => t.teamId === id) ?? { teamId: id, name: getTeamById(id)?.shortName ?? "팀" }) : teams;

  return <section className={styles.root} aria-label={`${data.season} 포스트시즌 대진`}>
    <div className={styles.heading}><Trophy className={styles.trophy} size={32} aria-hidden="true" /><div><p className={styles.eyebrow}>{data.season} POSTSEASON</p><h2>포스트시즌</h2></div><button type="button" className={styles.textLink} onClick={() => show()}>전체 대진 <ChevronRight size={14} aria-hidden="true" /></button></div>
    <div className={styles.match}>
      <div className={styles.matchTop}><b>{game?.displayLabel ?? stageNames[round.id]}</b><span className={styles.badge}>{states[round.state]}</span></div>
      <div className={styles.matchVisual}>
        {heroTeams.map((team, i) => <div className={styles.team} key={team.teamId ?? i} style={{ gridColumn: i === 0 ? 1 : 3, gridRow: 1 }}><Crest teamId={team.teamId} /><strong>{team.name} {team.rank && <small>{team.rank}위</small>}</strong><span className={styles.condition}>{team.teamId ? condition(team, round) : "대진 미정"}</span>{(round.games.some(g => g.status === "final")) && <small>실제 {team.wins ?? 0}승{round.draws > 0 ? ` · ${round.draws}무` : ""}</small>}</div>)}
        <div className={styles.matchCenter}>{game ? <><span>{dateLabel(game.date)}</span><b className={hasScore ? styles.score : ""}>{hasScore ? `${game.awayScore ?? "—"} : ${game.homeScore ?? "—"}` : game.status === "cancelled" ? "취소" : game.time}</b><small>{game.stadium} · {hasScore ? (game.status === "live" ? "진행 중" : "종료") : game.status === "cancelled" ? "재편성 확인 중" : "예정"}</small></> : <><b>VS</b><small>일정 확정 후 안내</small></>}</div>
      </div>
      {game && <Link href={`/games/${game.gameId}`} className={styles.gameAction}>{game.status === "final" ? "경기 결과 보기" : game.status === "cancelled" ? "경기 상태 확인" : "경기 보러가기"}<ArrowRight size={17} aria-hidden="true" /></Link>}
      {!game && <p className={styles.empty}>등록된 일정이 없어요. 대진과 일정은 확정 후 표시해요.</p>}
      <ul className={styles.games}>{otherGames.slice(0, 1).map(g => <GameRow key={g.gameId} game={g} />)}</ul>
      {otherGames.length > 1 && <button type="button" className={styles.allGames} onClick={() => show(index)}>전체 {round.games.length}경기 보기 <ChevronRight size={14} aria-hidden="true" /></button>}
    </div>
    <div className={styles.routeCard}><div className={styles.routeTitle}><b>한국시리즈까지의 여정</b><span>승자가 다음 라운드로</span></div><div className={styles.route}>{data.rounds.map((r, i) => {
      const pair = slots(data, r, i);
      const waiting = pair.find(p => p.teamId);
      const winner = r.participants.find(p => p.teamId === r.winnerId);
      const current = r.id === round.id;
      return <button key={r.id} type="button" className={`${styles.stop} ${current ? styles.current : ""}`} onClick={() => show(i)} aria-label={`${stageNames[r.id]} 대진 보기`}><span className={styles.node}>{current ? shortNames[r.id] : <Crest small teamId={winner?.teamId ?? waiting?.teamId} />}</span><b>{shortNames[r.id]}</b><small>{winner ? `${winner.name} ${r.id === "7" ? "우승" : "진출"}` : r.participants.length ? r.participants.map(p => p.name).join(" · ") : `${waiting?.name ?? "대진"} 대기`}</small></button>;
    })}</div></div>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} onCancel={() => setOpen(false)} onClose={() => setOpen(false)} onClick={e => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className={styles.sheet}>
        <div className={styles.sheetHeading}><div><p className={styles.eyebrow}>{data.season} POSTSEASON</p><h2 id={titleId}>우승까지, 한눈에</h2></div><button type="button" className={styles.close} onClick={() => setOpen(false)} aria-label="전체 대진 닫기" autoFocus><X size={20} /></button></div>
        <p className={styles.description}>각 라운드 승자가 다음 대기 팀과 만나요.</p>
        <div className={styles.bracket}>{data.rounds.map((r, i) => <section key={r.id} ref={el => { stageRefs.current[i] = el; }} className={`${styles.roundBox} ${r.id === round.id ? styles.activeRound : ""}`} aria-label={stageNames[r.id]}>
          <div className={styles.roundName}><h3>{stageNames[r.id]}</h3><small>{r.id === "4" ? "최대 2경기" : r.id === "7" ? "4선승제" : "3선승제"} · {states[r.state]}</small></div>
          <div className={styles.pair}>{slots(data, r, i).map((p, n) => <div key={p.teamId ?? n} className={styles.pairTeam}><Crest small teamId={p.teamId} /><div><b>{p.name}</b><small>{p.teamId ? p.rank ? `정규 ${p.rank}위` : "확정 팀" : "대진 미정"}{p.wins !== undefined ? ` · ${p.wins}승` : ""}</small></div>{n === 0 && <span className={styles.versus}>VS</span>}</div>)}</div>
          {r.id === "4" && <p className={styles.roundNote}>{slots(data, r, i).filter(p => p.teamId && (p.rank === 4 || p.rank === 5)).map(p => `${p.name} ${condition(p, r)}`).join(" · ")}</p>}
          {r.winnerId && <p className={styles.winner}>{r.participants.find(p => p.teamId === r.winnerId)?.name} {r.id === "7" ? "우승" : "진출"}</p>}
          {r.draws > 0 && <p className={styles.roundNote}>무승부 {r.draws}경기 · 승수는 실제 경기 결과 기준</p>}
          {r.games.length > 0 && <ul className={styles.games}>{r.games.map(g => <GameRow game={g} key={g.gameId} />)}</ul>}
          {i < 3 && <span className={styles.progress}>↓ {shortNames[r.id]} 승자 진출</span>}
        </section>)}</div>
        <div className={styles.champion}><Trophy size={30} aria-hidden="true" /><div><b>{data.season} 한국시리즈 우승</b><small>{data.rounds[3].participants.find(p => p.teamId === data.rounds[3].winnerId)?.name ?? "마지막까지 살아남을 한 팀"}</small></div></div>
        <p className={styles.note}>확정된 팀과 등록 일정만 표시해요.<br />경기 일정은 우천·시리즈 결과에 따라 변경될 수 있어요.</p>
      </div>
    </dialog>
  </section>;
}
