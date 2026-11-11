"""Install the paper-reader bridge into a Zotero profile.

Zotero normally installs an XPI from 工具 → 插件 → 齿轮 → 从文件安装插件. Some
Zotero builds drop unsigned add-ons on the next restart; this script registers
the add-on directly in the profile's `extensions.json` (with a backup), which is
what makes it survive restarts.

Usage:
    python install-zotero-addon.py                # auto-detect profiles
    python install-zotero-addon.py "C:\\path\\to\\profile"
    ZOTERO_PROFILE="..." python install-zotero-addon.py

Close Zotero before running, then start it again.
"""
import json
import os
import platform
import shutil
import sys
import time
import uuid
import zipfile

ADDON_ID = 'paper-reader-bridge@dsh.local'
HERE = os.path.dirname(os.path.abspath(__file__))
XPI_CANDIDATES = [
    os.path.join(HERE, 'paper-reader-bridge.xpi'),
    os.path.join(HERE, 'zotero-bridge', 'paper-reader-bridge.xpi'),
    os.path.join(os.path.dirname(HERE), 'paper-reader-bridge.xpi'),
]


def profile_roots():
    system = platform.system()
    home = os.path.expanduser('~')
    if system == 'Windows':
        appdata = os.environ.get('APPDATA', os.path.join(home, 'AppData', 'Roaming'))
        return [os.path.join(appdata, 'Zotero', 'Zotero', 'Profiles')]
    if system == 'Darwin':
        return [os.path.join(home, 'Library', 'Application Support', 'Zotero', 'Profiles')]
    return [
        os.path.join(home, '.zotero', 'zotero'),
        os.path.join(home, '.var', 'app', 'org.zotero.Zotero', '.zotero', 'zotero'),
    ]


def find_profiles(explicit):
    if explicit:
        return [explicit]
    if os.environ.get('ZOTERO_PROFILE'):
        return [os.environ['ZOTERO_PROFILE']]
    found = []
    for root in profile_roots():
        if not os.path.isdir(root):
            continue
        for name in os.listdir(root):
            candidate = os.path.join(root, name)
            if os.path.isfile(os.path.join(candidate, 'extensions.json')):
                found.append(candidate)
    found.sort(key=lambda path: os.path.getmtime(os.path.join(path, 'extensions.json')), reverse=True)
    return found


def find_xpi():
    for path in XPI_CANDIDATES:
        if os.path.isfile(path):
            return path
    raise SystemExit('paper-reader-bridge.xpi not found next to this script')


def build_record(template, manifest):
    now = int(time.time() * 1000)
    zotero = manifest.get('applications', {}).get('zotero', {})
    record = json.loads(json.dumps(template)) if template else {
        'type': 'extension',
        'visible': True,
        'active': True,
        'userDisabled': False,
        'appDisabled': False,
        'embedderDisabled': False,
        'installDate': now,
        'applyBackgroundUpdates': 1,
        'skinnable': False,
        'softDisabled': False,
        'foreignInstall': False,
        'strictCompatibility': True,
        'locales': [],
        'targetPlatforms': [],
        'dependencies': [],
    }
    record.update({
        'id': ADDON_ID,
        'syncGUID': '{%s}' % uuid.uuid4(),
        'version': manifest.get('version', '0.0.0'),
        'type': 'extension',
        'loader': None,
        'updateURL': zotero.get('update_url'),
        'manifestVersion': manifest.get('manifest_version', 2),
        'active': True,
        'userDisabled': False,
        'appDisabled': False,
        'embedderDisabled': False,
        'softDisabled': False,
        'installDate': now,
        'updateDate': now,
        'path': None,
        'targetApplications': [{
            'id': 'zotero@zotero.org',
            'minVersion': zotero.get('strict_min_version', '7.0'),
            'maxVersion': zotero.get('strict_max_version', '*'),
        }],
        'signedState': 0,
        'signedTypes': [],
        'signedDate': None,
        'seen': True,
        'defaultLocale': {
            'name': 'Paper Reader Bridge',
            'description': 'Local bridge used by the DSH paper reading module to attach note PDFs to Zotero items.',
            'creator': 'DSH paper reader',
            'developers': None,
            'translators': None,
            'contributors': None,
        },
    })
    return record


def install(profile, xpi):
    registry_path = os.path.join(profile, 'extensions.json')
    with open(registry_path, encoding='utf-8') as handle:
        data = json.load(handle)
    with zipfile.ZipFile(xpi) as archive:
        manifest = json.loads(archive.read('manifest.json').decode('utf-8'))

    extensions_dir = os.path.join(profile, 'extensions')
    os.makedirs(extensions_dir, exist_ok=True)
    target = os.path.join(extensions_dir, ADDON_ID + '.xpi')
    shutil.copy2(xpi, target)

    backup = registry_path + '.bak-' + time.strftime('%Y%m%d-%H%M%S')
    shutil.copy2(registry_path, backup)

    addons = data.setdefault('addons', [])
    template = next((item for item in addons if item.get('type') == 'extension'), None)
    record = build_record(template, manifest)
    record['path'] = target

    existing = next((item for item in addons if item.get('id') == ADDON_ID), None)
    if existing:
        existing.clear()
        existing.update(record)
    else:
        addons.append(record)

    with open(registry_path, 'w', encoding='utf-8') as handle:
        json.dump(data, handle, ensure_ascii=False)
    return backup


def main():
    explicit = sys.argv[1] if len(sys.argv) > 1 else None
    xpi = find_xpi()
    profiles = find_profiles(explicit)
    if not profiles:
        raise SystemExit('no Zotero profile with extensions.json found; pass the profile path explicitly')
    for profile in profiles:
        backup = install(profile, xpi)
        print('installed %s -> %s' % (ADDON_ID, profile))
        print('  registry backup: %s' % backup)
    print('start Zotero and check 工具 → 插件 for "Paper Reader Bridge"')


if __name__ == '__main__':
    main()
