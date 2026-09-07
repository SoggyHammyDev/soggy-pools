from pathlib import Path
import re

# BCHN reports Testnet4 from getblockchaininfo as "test4". The BCH CKPool fork
# historically used the longer "testnet4" alias in its CashAddr network-prefix
# selection. Extend positive string-equality checks for testnet4 to also accept
# test4. This is intentionally narrow: it only rewrites C comparisons, not every
# string literal in the source tree.
files = list(Path('src').glob('*.c')) + list(Path('src').glob('*.h'))
patched = 0

positive_patterns = [
    # !strcmp(chain, "testnet4"), !strcasecmp(...), !safecmp(...)
    re.compile(r'!(?P<fn>strcmp|strcasecmp|safecmp)\(\s*(?P<lhs>[^,\n]+?)\s*,\s*"testnet4"\s*\)'),
    # strcmp(chain, "testnet4") == 0 (same for helpers)
    re.compile(r'(?P<fn>strcmp|strcasecmp|safecmp)\(\s*(?P<lhs>[^,\n]+?)\s*,\s*"testnet4"\s*\)\s*==\s*0'),
]

for path in files:
    text = path.read_text()
    original = text

    def neg_repl(m):
        global patched
        fn, lhs = m.group('fn'), m.group('lhs')
        # Don't duplicate if this exact nearby expression was already patched.
        replacement = f'(!{fn}({lhs}, "testnet4") || !{fn}({lhs}, "test4"))'
        patched += 1
        return replacement

    def eq_repl(m):
        global patched
        fn, lhs = m.group('fn'), m.group('lhs')
        replacement = f'({fn}({lhs}, "testnet4") == 0 || {fn}({lhs}, "test4") == 0)'
        patched += 1
        return replacement

    # Avoid touching a source file that already explicitly knows test4.
    if '"testnet4"' in text and '"test4"' not in text:
        text = positive_patterns[0].sub(neg_repl, text)
        text = positive_patterns[1].sub(eq_repl, text)

    if text != original:
        path.write_text(text)
        print(f'Soggy Pools test4 patch updated {path}')

if patched:
    print(f'Soggy Pools test4 patch applied to {patched} comparison(s)')
else:
    # The fixed fallback payout conversion still makes named-worker Testnet4
    # mining safe. Do not make future upstream refactors fail the whole image
    # solely because this optional compatibility comparison moved.
    print('Soggy Pools test4 source comparison patch: no compatible anchor needed/found')
