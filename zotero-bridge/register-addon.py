"""Register the bridge XPI in Zotero's addon registry (Firefox extensions.json).

Used only when the in-app installer drops the add-on on restart. A backup of
extensions.json is written next to it before any change.
"""
import json
import os
import shutil
import time
import uuid

PROFILE = os.path.expandvars(r'%APPDATA%\Zotero\Zotero\Profiles\vjrsuzu9.default')
XPISRC = r'E:\tkxwork_DS\shared\paper-reader\paper-reader-bridge.xpi'
ADDON_ID = 'paper-reader-bridge@dsh.local'
XPI_NAME = ADDON_ID + '.xpi'

registry_path = os.path.join(PROFILE, 'extensions.json')
xpi_path = os.path.join(PROFILE, 'extensions', XPI_NAME)

shutil.copy2(XPISRC, xpi_path)
shutil.copy2(registry_path, registry_path + '.dsh-backup')

with open(registry_path, encoding='utf-8') as handle:
    data = json.load(handle)

manifest = json.loads(__import__('zipfile').ZipFile(xpi_path).read('manifest.json').decode('utf-8'))
zotero_app = manifest['applications']['zotero']

template = next(a for a in data['addons'] if a['id'] == 'zoterogpt@polygon.org')
record = json.loads(json.dumps(template))
now = int(time.time() * 1000)

record.update({
    'id': ADDON_ID,
    'syncGUID': '{%s}' % uuid.uuid4(),
    'version': manifest['version'],
    'updateURL': zotero_app.get('update_url'),
    'installOrigins': None,
    'manifestVersion': manifest.get('manifest_version', 2),
    'defaultLocale': {
        'name': manifest['name'],
        'description': manifest.get('description', ''),
        'creator': manifest.get('author'),
        'homepageURL': manifest.get('homepage_url'),
        'developers': None,
        'translators': None,
        'contributors': None,
    },
    'active': True,
    'userDisabled': False,
    'appDisabled': False,
    'softDisabled': False,
    'installDate': now,
    'updateDate': now,
    'path': xpi_path,
    'sourceURI': None,
    'targetApplications': [{
        'id': 'zotero@zotero.org',
        'minVersion': zotero_app.get('strict_min_version'),
        'maxVersion': zotero_app.get('strict_max_version'),
    }],
    'icons': manifest.get('icons', {}),
    'rootURI': 'jar:file:///' + xpi_path.replace('\\', '/') + '!/',
    'location': 'app-profile',
    'seen': True,
})

data['addons'] = [a for a in data['addons'] if a['id'] != ADDON_ID]
data['addons'].append(record)

temporary = registry_path + '.tmp'
with open(temporary, 'w', encoding='utf-8') as handle:
    json.dump(data, handle, ensure_ascii=False)
os.replace(temporary, registry_path)

print('registered', ADDON_ID, manifest['version'])
print('xpi ->', xpi_path)
