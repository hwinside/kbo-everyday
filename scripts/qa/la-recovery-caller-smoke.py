"""Compile the actual production caller, not a reimplementation of its algorithm."""
from pathlib import Path
import subprocess
import sys

out = Path(sys.argv[1])
source = Path('ios/App/App/LiveActivityController.swift').read_text()
start = source.index('    private func convergeRecoveryCards(gameId: String) async {')
end = source.index('\n    private func forgetRecoveryAck', start)
body = source[start:end].replace('private func', 'func', 1)
fixture = Path('scripts/qa/la-recovery-caller-fixture.swift').read_text()
mutations = {
    'normal': body,
    'policy-bypass': body.replace('let keepId = RecoveryCardPolicy.keep(cards.map {\n                .init(id: $0.id, channel: $0.attributes.channelId, attempt: $0.attributes.recoveryAttempt)\n            }, channel: channel)', 'let keepId = cards.first?.id'),
    'end-removed': body.replace('await card.end(using: card.contentState, dismissalPolicy: .immediate)', '_ = card.id'),
    'ack-removed': body.replace('ackChannelActivity(gameId: gameId, channelId: channel, activityId: survivor.id)', '_ = survivor.id'),
    'ack-reset-removed': body.replace('forgetRecoveryAck(activityId: survivor.id)', '_ = survivor.id'),
}
for name, candidate in mutations.items():
    if name != 'normal' and candidate == body:
        raise SystemExit(f'FAIL mutation target missing: {name}')
    swift = out / f'caller-{name}.swift'
    binary = out / f'caller-{name}'
    swift.write_text(fixture.replace('// PRODUCTION_BODY', candidate))
    # Compilation errors are infrastructure failures, never mutation RED evidence.
    subprocess.run(['swiftc', '-o', str(binary), 'ios/App/App/ChannelAckPolicy.swift',
                    'ios/App/App/ChannelMigrationPolicy.swift', str(swift)], check=True)
    with (out / f'caller-{name}.log').open('w') as log:
        result = subprocess.run([str(binary)], stdout=log, stderr=log)
    if (result.returncode == 0) != (name == 'normal'):
        raise SystemExit(f'FAIL caller {name}: exit {result.returncode}')
    print(f'PASS production caller {name}: ' + ('normal' if name == 'normal' else 'mutation RED'))
