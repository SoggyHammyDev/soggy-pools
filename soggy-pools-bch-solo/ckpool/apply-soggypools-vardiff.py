from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(
            f'expected exactly one patch anchor in {path}, found {count}: {old[:100]!r}'
        )
    p.write_text(text.replace(old, new, 1))


def replace_span(path, start, end, replacement):
    """Replace one source region using small stable boundary markers.

    CKPool's comments and spacing around the VarDiff implementation have changed
    between commits.  Matching the whole function body made the Docker build
    unnecessarily brittle.  These two code markers are the semantic boundaries
    we actually care about.
    """
    p = Path(path)
    text = p.read_text()

    starts = [i for i in range(len(text)) if text.startswith(start, i)]
    if len(starts) != 1:
        raise SystemExit(
            f'expected exactly one start marker in {path}, found {len(starts)}: {start!r}'
        )
    start_i = starts[0]
    end_i = text.find(end, start_i + len(start))
    if end_i < 0:
        raise SystemExit(f'end marker not found in {path}: {end!r}')
    if text.find(end, end_i + len(end)) >= 0:
        # There may be other identical comments elsewhere in a large C file;
        # only fail if one occurs before our next function boundary is obvious.
        pass

    p.write_text(text[:start_i] + replacement + text[end_i:])


replace_once(
    'src/ckpool.h',
    '''\tint64_t maxdiff; // No default\n\n\t/* Difficulty overrides for specific worker patterns */''',
    '''\tint64_t maxdiff; // No default\n\n\t/* Soggy Pools configurable VarDiff policy. */\n\tbool vardiff_enabled;\n\tint vardiff_target_sec;\n\tint vardiff_retarget_sec;\n\tdouble vardiff_tolerance;\n\tint vardiff_max_up_factor;\n\tint vardiff_max_down_factor;\n\tint vardiff_grace_sec;\n\n\t/* Difficulty overrides for specific worker patterns */'''
)

replace_once(
    'src/ckpool.c',
    '''\tjson_get_int64(&ckp->mindiff, json_conf, "mindiff");\n\tjson_get_int64(&ckp->startdiff, json_conf, "startdiff");\n\tjson_get_int64(&ckp->highdiff, json_conf, "highdiff");\n\tjson_get_int64(&ckp->maxdiff, json_conf, "maxdiff");''',
    '''\tjson_get_int64(&ckp->mindiff, json_conf, "mindiff");\n\tjson_get_int64(&ckp->startdiff, json_conf, "startdiff");\n\tjson_get_int64(&ckp->highdiff, json_conf, "highdiff");\n\tjson_get_int64(&ckp->maxdiff, json_conf, "maxdiff");\n\tjson_get_bool(&ckp->vardiff_enabled, json_conf, "vardiff_enabled");\n\tjson_get_int(&ckp->vardiff_target_sec, json_conf, "vardiff_target_sec");\n\tjson_get_int(&ckp->vardiff_retarget_sec, json_conf, "vardiff_retarget_sec");\n\tjson_get_double(&ckp->vardiff_tolerance, json_conf, "vardiff_tolerance");\n\tjson_get_int(&ckp->vardiff_max_up_factor, json_conf, "vardiff_max_up_factor");\n\tjson_get_int(&ckp->vardiff_max_down_factor, json_conf, "vardiff_max_down_factor");\n\tjson_get_int(&ckp->vardiff_grace_sec, json_conf, "vardiff_grace_sec");'''
)

replace_once(
    'src/ckpool.c',
    '''\tmemset(&ckp, 0, sizeof(ckp));\n\tckp.starttime = time(NULL);''',
    '''\tmemset(&ckp, 0, sizeof(ckp));\n\t/* Preserve upstream behaviour unless config explicitly changes it. */\n\tckp.vardiff_enabled = true;\n\tckp.vardiff_target_sec = 10;\n\tckp.vardiff_retarget_sec = 30;\n\tckp.vardiff_tolerance = 0.30;\n\tckp.vardiff_max_up_factor = 8;\n\tckp.vardiff_max_down_factor = 4;\n\tckp.vardiff_grace_sec = 15;\n\tckp.starttime = time(NULL);'''
)

replace_once(
    'src/ckpool.c',
    '''\tif (!ckp.highdiff)\n\t\tckp.highdiff = 1000000;\n\tif (!ckp.logdir)''',
    '''\tif (!ckp.highdiff)\n\t\tckp.highdiff = 1000000;\n\tif (ckp.vardiff_target_sec < 1)\n\t\tckp.vardiff_target_sec = 10;\n\tif (ckp.vardiff_retarget_sec < 1)\n\t\tckp.vardiff_retarget_sec = 30;\n\tif (ckp.vardiff_tolerance < 0.0 || ckp.vardiff_tolerance > 1.0)\n\t\tckp.vardiff_tolerance = 0.30;\n\tif (ckp.vardiff_max_up_factor < 1)\n\t\tckp.vardiff_max_up_factor = 8;\n\tif (ckp.vardiff_max_down_factor < 1)\n\t\tckp.vardiff_max_down_factor = 4;\n\tif (ckp.vardiff_grace_sec < 0)\n\t\tckp.vardiff_grace_sec = 15;\n\tif (!ckp.logdir)'''
)

# Replace only the adaptive-difficulty calculation.  The clamps and the actual
# stratum_send_diff() logic after this region stay upstream CKPool code.
replace_span(
    'src/stratifier.c',
    '\tclient->ssdc++;\n',
    '\t/* Clamp to mindiff ~ network_diff */',
    '''\tif (!ckp->vardiff_enabled)\n\t\treturn;\n\n\tclient->ssdc++;\n\tbdiff = sane_tdiff(&now_t, &client->first_share);\n\ttdiff = sane_tdiff(&now_t, &client->ldc);\n\n\t/* Soggy Pools VarDiff: target one share every vardiff_target_sec and\n\t * retarget after vardiff_retarget_sec (or the equivalent share count). */\n\tif (bdiff < ckp->vardiff_grace_sec)\n\t\treturn;\n\t{\n\t\tint target_shares = MAX(1, ckp->vardiff_retarget_sec / ckp->vardiff_target_sec);\n\t\tif (client->ssdc < target_shares && tdiff < ckp->vardiff_retarget_sec)\n\t\t\treturn;\n\t}\n\n\tif (diff != client->diff) {\n\t\tclient->ssdc = 0;\n\t\treturn;\n\t}\n\n\t/* dsps is difficulty-shares/second. Multiplying by the target interval\n\t * gives the share difficulty that should average one share per target. */\n\tif (ckp->vardiff_retarget_sec <= 60) {\n\t\tbias = time_bias(bdiff, 60);\n\t\tdsps = client->dsps1 / bias;\n\t} else {\n\t\tbias = time_bias(bdiff, 300);\n\t\tdsps = client->dsps5 / bias;\n\t}\n\tif (unlikely(dsps <= 0.0))\n\t\treturn;\n\tdrr = dsps * (double)ckp->vardiff_target_sec / (double)client->diff;\n\n\tif (drr > (1.0 - ckp->vardiff_tolerance) &&\n\t    drr < (1.0 + ckp->vardiff_tolerance))\n\t\treturn;\n\n\t/* Client suggest diff overrides worker mindiff. */\n\tif (client->suggest_diff)\n\t\tmindiff = client->suggest_diff;\n\telse\n\t\tmindiff = worker->mindiff;\n\n\toptimal = lround(dsps * (double)ckp->vardiff_target_sec);\n\n\t/* Avoid giant single-step difficulty jumps on bursty hashrate. */\n\tif (optimal > client->diff) {\n\t\tdouble max_up = (double)client->diff * ckp->vardiff_max_up_factor;\n\t\tif ((double)optimal > max_up)\n\t\t\toptimal = lround(max_up);\n\t} else if (optimal < client->diff) {\n\t\tint64_t min_down = MAX((int64_t)1, client->diff / ckp->vardiff_max_down_factor);\n\t\toptimal = MAX(optimal, min_down);\n\t}\n\n'''
)

print('Soggy Pools VarDiff patch applied')
