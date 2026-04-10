import type { Metadata } from "next";
import LegalPageLayout from "@/components/legal/LegalPageLayout";

export const metadata: Metadata = {
  title: "크보팬 개인정보처리방침",
  description: "크보팬 개인정보처리방침입니다.",
};

const collectionItems = [
  "로그인 정보: 이메일 주소, 소셜 로그인 제공자 식별값, 닉네임, 프로필 이미지",
  "서비스 이용 정보: 응원 구단, 최애 선수, 포인트, 등급, 활동 기록",
  "커뮤니티 데이터: 게시글, 댓글, 채팅, 쪽지(DM) 내용",
  "안전 운영 데이터: 신고 내역, 차단 내역, 제재 이력",
  "기능 이용 데이터: 승부예측 기록, AI 요약 또는 AI 예측 요청 기록, 밈 편집 결과물",
  "접속 및 기기 정보: 접속 로그, 서비스 이용 기록, 쿠키 또는 기기 식별 정보, 오류 로그",
];

const purposes = [
  "회원 식별, 인증, 계정 관리",
  "커뮤니티, 쪽지, 예측, AI 기능 등 서비스 제공",
  "개인화된 콘텐츠 및 기능 제공",
  "신고 처리, 이상행위 탐지, 제재 및 분쟁 대응",
  "서비스 안정화, 통계 분석, 품질 개선",
  "법령상 의무 이행 및 민원 대응",
];

const processors = [
  "Supabase (미국): 데이터베이스, 인증, 스토리지 운영",
  "Vercel (미국): 웹 애플리케이션 호스팅 및 로그 처리",
  "Google (미국): OAuth 로그인 및 일부 분석 도구 제공",
];

const rights = [
  "개인정보 열람, 정정, 삭제 요청",
  "개인정보 처리정지 요청",
  "회원 탈퇴 및 계정 삭제 요청",
  "개인정보 관련 문의 및 민원 제기",
];

export default function PrivacyPage() {
  return (
    <LegalPageLayout title="크보팬 개인정보처리방침" effectiveDate="2026-04-10" updatedAt="2026-04-10">
      <p className="text-sm leading-7 text-text-secondary sm:text-base">
        크보팬은 회원의 개인정보를 소중하게 생각하며, 관련 법령을 준수하기 위해 노력합니다. 본 방침은 서비스가 어떤 정보를 수집하고 어떻게 이용·보관·파기하는지 설명합니다.
      </p>

      <section className="space-y-3">
        <h2 className="text-xl font-bold text-text-primary">1. 수집하는 개인정보 항목</h2>
        <p className="text-sm leading-7 text-text-secondary sm:text-base">
          서비스는 회원가입, 서비스 제공, 안전 운영 및 품질 개선을 위해 아래 정보를 수집할 수 있습니다.
        </p>
        <ul className="list-disc space-y-2 pl-5 text-sm leading-7 text-text-secondary sm:text-base">
          {collectionItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="text-sm leading-7 text-text-secondary sm:text-base">
          개인정보는 소셜 로그인 제공자, 회원의 직접 입력, 서비스 이용 과정에서 자동 생성되는 방식으로 수집됩니다.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-bold text-text-primary">2. 개인정보 이용 목적</h2>
        <ul className="list-decimal space-y-2 pl-5 text-sm leading-7 text-text-secondary sm:text-base">
          {purposes.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-bold text-text-primary">3. 개인정보 보유 및 파기</h2>
        <ul className="list-disc space-y-2 pl-5 text-sm leading-7 text-text-secondary sm:text-base">
          <li>회원 정보는 회원 탈퇴 시까지 보관합니다.</li>
          <li>게시글, 댓글 등 공개 콘텐츠는 탈퇴 후 작성자 정보를 비식별 처리한 상태로 남을 수 있습니다.</li>
          <li>접속 로그 등 일부 정보는 관계 법령에 따라 일정 기간 보관 후 파기할 수 있습니다.</li>
          <li>신고, 제재, 분쟁 대응 기록은 서비스 안전 운영을 위해 필요한 범위 내에서 합리적인 기간 동안 보관할 수 있습니다.</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-bold text-text-primary">4. 개인정보 제3자 제공</h2>
        <p className="text-sm leading-7 text-text-secondary sm:text-base">
          서비스는 원칙적으로 회원의 개인정보를 외부에 제공하지 않습니다. 다만, 회원의 별도 동의가 있거나 법령에 따라 제공 의무가 있는 경우에는 예외로 할 수 있습니다.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-bold text-text-primary">5. 개인정보 처리 위탁 및 국외 이전</h2>
        <p className="text-sm leading-7 text-text-secondary sm:text-base">
          서비스 운영을 위해 일부 업무를 외부 서비스 제공업체에 위탁하며, 이 과정에서 개인정보가 국외 서버에 저장 또는 처리될 수 있습니다.
        </p>
        <ul className="list-disc space-y-2 pl-5 text-sm leading-7 text-text-secondary sm:text-base">
          {processors.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="text-sm leading-7 text-text-secondary sm:text-base">
          위 업체들은 글로벌 클라우드 인프라를 사용하므로 개인정보가 미국 등 해외에서 처리될 수 있으며, 서비스는 계약상·기술상 보호조치를 통해 개인정보를 보호하기 위해 노력합니다.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-bold text-text-primary">6. 회원의 권리</h2>
        <ul className="list-decimal space-y-2 pl-5 text-sm leading-7 text-text-secondary sm:text-base">
          {rights.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="text-sm leading-7 text-text-secondary sm:text-base">
          관련 요청은 서비스 내 기능 또는 아래 문의처를 통해 접수할 수 있습니다.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-bold text-text-primary">7. 쿠키 및 분석 도구</h2>
        <ul className="list-disc space-y-2 pl-5 text-sm leading-7 text-text-secondary sm:text-base">
          <li>서비스는 로그인 상태 유지, 기능 제공, 통계 분석을 위해 쿠키 또는 유사 기술을 사용할 수 있습니다.</li>
          <li>Google Analytics, Vercel Analytics 등 비식별 또는 최소한의 분석 도구를 사용할 수 있습니다.</li>
          <li>브라우저 설정을 통해 쿠키 저장을 거부할 수 있으나, 일부 기능 이용이 제한될 수 있습니다.</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-bold text-text-primary">8. 개인정보 보호책임자 및 문의처</h2>
        <ul className="list-disc space-y-2 pl-5 text-sm leading-7 text-text-secondary sm:text-base">
          <li>개인정보 보호책임자: 김현우</li>
          <li>문의처: privacy@keubo.fan</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-bold text-text-primary">9. 방침 변경</h2>
        <p className="text-sm leading-7 text-text-secondary sm:text-base">
          본 방침은 법령, 서비스 정책 또는 운영상 필요에 따라 변경될 수 있으며, 중요한 변경이 있을 경우 서비스 내 공지사항 또는 별도 안내를 통해 알립니다.
        </p>
      </section>
    </LegalPageLayout>
  );
}
