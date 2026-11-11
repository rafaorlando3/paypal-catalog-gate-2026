"""Prepared video-only harness. Execute only on authorized public Linux CI.

Does not repeat qualified unit/e2e suites. Records the labeled offline fixture
and displays separately reviewed stored real receipts. No provider credentials.
"""
import base64
import hashlib
import json
import os
import re
import runpy
import stat
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

BASELINE = '8f4739cda6f8b368f179bf2e2f797826fda94a46'
PRODUCT = 'e7955eda8e9413224a6b7541be40e5ede4638a57'
HELPER_SHA = '28123ae4428e7aa7278c859affb665b83739c10f0c748a07405791a246eb0cdc'
PINS_SHA = '11aa04eb900d1533d67aef51d3bdbeb5089c50b960ef16aafdbf96dc0795e533'
OVERLAY = {'.demo/video.py', '.demo/record.mjs', '.demo/video-pins.json', '.demo/evidence.json',
           '.github/workflows/qualify-paypal-offline.yml'}
FRAMES = ['01-introduction.png', '02-fixture-findings.png', '03-fixture-blocked.png',
          '04-fixture-human-gate.png', '05-fixture-captured.png', '06-actual-AI.png',
          '07-actual-Sandbox.png', '08-repository.png']

def require(value, message):
    if not value:
        raise RuntimeError(message)

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def frames_to_log(files):
    total = sum(len(raw) for _, raw in files)
    require(total <= 16 * 1024 * 1024, 'Evidence byte budget exceeded')
    for name, raw in files:
        require(re.fullmatch(r'[A-Za-z0-9_.-]+', name), 'Evidence name')
        encoded = base64.b64encode(raw).decode()
        print('CGVIDEO_BEGIN|' + json.dumps({'name': name, 'bytes': len(raw), 'sha256': sha(raw)}), flush=True)
        for index, start in enumerate(range(0, len(encoded), 4096)):
            print('CGVIDEO_DATA|' + name + '|' + str(index) + '|' + encoded[start:start+4096], flush=True)
        print('CGVIDEO_END|' + name, flush=True)

def main():
    require(sys.platform.startswith('linux') and os.environ.get('GITHUB_ACTIONS') == 'true', 'Linux GitHub CI only')
    require(os.environ.get('GITHUB_REPOSITORY') == 'rafaorlando3/paypal-catalog-gate-2026', 'Repository identity')
    require(os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch', 'Explicit dispatch only')
    require(os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'No automatic rerun of this source')
    require(os.environ.get('GITHUB_REF_NAME', '').startswith('demo-'), 'Dedicated reviewed candidate branch only')
    root = Path(__file__).resolve().parents[1]
    require(sha((root/'.ci/qualify.py').read_bytes()) == HELPER_SHA, 'Qualified helper pin')
    require(sha((root/'.ci/pins.json').read_bytes()) == PINS_SHA, 'Qualified dependency/source pins')
    # Definitions only: the qualified helper's main() and its test suites do not run.
    helper = runpy.run_path(str(root/'.ci/qualify.py'), run_name='video_helpers_only')
    deadline = time.monotonic() + 570
    helper['set_active_deadline'](deadline)
    run = helper['run_cmd']
    def command(args, cap=30, check=True):
        return run(args, timeout=cap, deadline=deadline-120, check=check, cwd=str(root))
    require(command(['git','rev-parse','HEAD']).stdout.strip() == os.environ['GITHUB_SHA'], 'Actual dispatched SHA')
    changed = set(command(['git','diff','--name-only',BASELINE,'HEAD']).stdout.splitlines())
    require(changed == OVERLAY, 'Only five reviewed video overlay paths may change')
    require(not command(['git','status','--porcelain']).stdout.strip(), 'Clean checkout')
    pins = json.loads((root/'.ci/pins.json').read_bytes())
    vpins = json.loads((root/'.demo/video-pins.json').read_bytes())
    require(vpins['schema'] == 'catalog-gate-video-v1' and vpins['product'] == PRODUCT, 'Video pins schema')
    for name in ['video.py','record.mjs','evidence.json']:
        require(sha((root/'.demo'/name).read_bytes()) == vpins['files'][name], 'Video source/evidence pin: '+name)
    evidence_raw = (root/'.demo/evidence.json').read_bytes()
    require(len(evidence_raw)<=8000, 'Public evidence size')
    evidence = json.loads(evidence_raw)
    require(set(evidence)=={'schema','real_sandbox_complete','product','ai','sandbox'}, 'No additional evidence fields or credentials')
    require(evidence['schema']=='catalog-gate-public-demo-evidence-v1'
        and evidence['real_sandbox_complete'] is True and evidence['product']==PRODUCT, 'Real reviewed evidence required before recording')
    ai = evidence['ai']
    require(set(ai)=={'attempts','answers','second','third','answer_text'}, 'Only the public synthetic AI sample')
    require(sha(ai['answer_text'].encode())==vpins['ai_answer_sha256'] and ai['attempts']==2
        and ai['answers']==1 and ai['second']=='advisory_timeout' and ai['third']=='not_attempted', 'Exact partial actual AI result')
    sandbox = evidence['sandbox']
    require(set(sandbox)=={'capture','webhook','human_exact_acceptance','buyer_approved'}, 'Sanitized Sandbox metadata only')
    capture, hook = sandbox['capture'], sandbox['webhook']
    require(set(capture)=={'id','status','amount','currency','final_capture'}, 'Capture metadata only')
    require(set(hook)=={'event_id','event_type','capture_id','signature_verified'}, 'No raw webhook or signature headers')
    require(capture['status']=='COMPLETED' and capture['amount']=='50.00' and capture['currency']=='USD'
        and capture['final_capture'] is True and sandbox['buyer_approved'] is True
        and sandbox['human_exact_acceptance'] is True, 'Exact actual full Sandbox capture and personal gates')
    require(all(isinstance(x,str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}',x)
        for x in [capture['id'],hook['event_id'],hook['capture_id']]), 'Sanitized test identifiers')
    require(hook['capture_id']==capture['id'] and hook['event_type']=='PAYMENT.CAPTURE.COMPLETED'
        and hook['signature_verified'] is True, 'Signed webhook must identify this exact capture')
    require(pins['product']['commit'] == PRODUCT and pins['product']['blobs'] == 56, 'Product identity')
    require(command(['git','rev-parse',PRODUCT+'^{tree}']).stdout.strip() == pins['product']['tree'], 'Product Git tree')
    run_id = os.environ.get('GITHUB_RUN_ID','')
    require(re.fullmatch(r'[0-9]+',run_id), 'Run identity')
    name = 'cg-video-'+run_id+'-1'
    preexisting = command(['docker','ps','-aq','--no-trunc','--filter','name=^/'+name+'$']).stdout.strip()
    require(not preexisting, 'Preexisting container: do not touch')
    create_intent = False
    create_outcome = 'not_started'
    cid = ''
    image_id = ''
    wait_rc = ''
    timed_out = False
    failure = None
    closure = None
    with tempfile.TemporaryDirectory(prefix='cg-video-',ignore_cleanup_errors=True) as tmp:
        tmp = Path(tmp)
        product = tmp/'product'
        vendor = tmp/'vendor'
        output = tmp/'evidence'
        for d in [product, vendor, output]:
            d.mkdir(mode=0o755)
        output.chmod(0o1777)  # Only disposable media output is writable by the container.
        for row in pins['product']['files']:
            rel = Path(row['path'])
            require(not rel.is_absolute() and '..' not in rel.parts, 'Product relative path')
            extracted = subprocess.run(['git','show',PRODUCT+':'+row['path']],cwd=root,
                stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                timeout=helper['remaining'](deadline-120,15),check=False)
            require(extracted.returncode == 0, 'Product Git blob extraction failed')
            raw = extracted.stdout  # bytes: do not normalize line endings
            require(len(raw) == row['bytes'] and sha(raw) == row['sha256'], 'Product extraction pin')
            dest = product/rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(raw)
        before = helper['verify_directory_against_pins'](product,pins['product']['files'],376269,deadline-120)
        image = pins['toolchain']['image']
        try:
            command(['docker','pull','--platform','linux/amd64',image],120)
            info = json.loads(command(['docker','image','inspect',image]).stdout)[0]
            require(image in info['RepoDigests'] and info['Os']=='linux' and info['Architecture']=='amd64', 'Pinned image/platform')
            image_id = info['Id']
            for package in pins['toolchain']['npm']:
                helper['download_and_extract_npm_pkg'](package,vendor/'node_modules',deadline-240)
            args = ['docker','create','--name',name,'--label','cg.run='+name,
                '--platform','linux/amd64','--network','none','--init','--read-only',
                '--cap-drop','ALL','--security-opt','no-new-privileges','--ipc','private',
                '--shm-size','256m','--cpus','2','--memory','3g','--pids-limit','256',
                '--tmpfs','/tmp:rw,nosuid,nodev,size=1073741824,mode=1777',
                '--log-driver','json-file','--log-opt','max-size=1m','--log-opt','max-file=1',
                '--mount','type=bind,src='+str(product)+',dst=/product,readonly',
                '--mount','type=bind,src='+str(vendor)+',dst=/vendor,readonly',
                '--mount','type=bind,src='+str(root/'.demo')+',dst=/video,readonly',
                '--mount','type=bind,src='+str(output)+',dst=/evidence',
                image_id,'/usr/bin/env','-i','PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                'HOME=/tmp','TMPDIR=/tmp','LANG=C.UTF-8','MODE=fixture','NODE_PATH=/vendor/node_modules',
                'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright','node','/video/record.mjs']
            create_intent = True
            created = command(args,30,False)
            create_outcome = 'success' if created.returncode == 0 else 'failed_or_uncertain'
            cid = created.stdout.strip()
            require(created.returncode == 0 and re.fullmatch(r'[a-f0-9]{64}',cid), 'Create uncertain: reconcile, no retry')
            observed = json.loads(command(['docker','inspect',cid]).stdout)[0]
            hc = observed['HostConfig']
            require(observed['Image']==image_id and observed['Config']['Labels']['cg.run']==name, 'Owned immutable container')
            require(hc['NetworkMode']=='none' and hc['ReadonlyRootfs'] and hc['Memory']==3*1024**3
                and hc['PidsLimit']==256 and hc['NanoCpus']==2*10**9, 'Exact bounded network-none profile')
            command(['docker','start',cid],30)
            try:
                waited = command(['docker','wait',cid],220,False)
                wait_rc = waited.stdout.strip()
                require(waited.returncode==0 and wait_rc=='0', 'Video worker failed')
            except subprocess.TimeoutExpired:
                timed_out = True
                raise RuntimeError('Video worker timeout: no retry')
        except Exception as error:
            failure = str(error)
        finally:
            closure = helper['reconcile_and_close_container'](name,image_id,create_intent,
                create_outcome,cid,False,wait_rc,timed_out,min(deadline,time.monotonic()+110))
        require(closure['closure_confirmed'] is True, 'Container closure uncertain; do not qualify media')
        terminal = closure.get('terminal_inspect') or {}
        require(failure is None and terminal.get('pid')==0 and terminal.get('exit_code')==0
            and terminal.get('oom_killed') is False, 'Video not qualified: '+str(failure))
        after = helper['verify_directory_against_pins'](product,pins['product']['files'],376269,deadline)
        report = json.loads((output/'video-report.json').read_bytes())
        movie = (output/'catalog-gate-demo.webm').read_bytes()
        require(movie[:4] == bytes.fromhex('1a45dfa3') and 10000 < len(movie) <= 8*1024**2, 'WebM signature/size')
        require(110 <= report['actual_duration_seconds'] < 180 and report['sha256']==sha(movie)
            and report['bytes']==len(movie) and report['frames']==FRAMES, 'Decoded media report')
        exported = [('catalog-gate-demo.webm',movie)]
        for filename in FRAMES:
            path = output/filename
            st = path.lstat()
            require(stat.S_ISREG(st.st_mode) and st.st_size<=2*1024**2, 'Bounded regular PNG')
            raw = path.read_bytes()
            require(raw[:8]==bytes.fromhex('89504e470d0a1a0a') and struct.unpack('>II',raw[16:24])==(1280,720), 'PNG dimensions')
            exported.append((filename,raw))
        summary = {'state':'VIDEO_RECORDED_AND_CONTAINER_CLOSED_VISUAL_REVIEW_PENDING',
            'product':PRODUCT,'candidate':os.environ['GITHUB_SHA'],'run':run_id,
            'source_before':before,'source_after':after,'closure':closure,'video':report,
            'provider_calls':0,'secrets_passed':False,'unit_suites_repeated':False}
        exported.extend([('video-report.json',(output/'video-report.json').read_bytes()),
                         ('video-CI-summary.json',json.dumps(summary,indent=2).encode())])
        frames_to_log(exported)
        print('VIDEO_RECORDED_VISUAL_AND_CONTENT_REVIEW_STILL_REQUIRED',flush=True)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('VIDEO_NOT_QUALIFIED: '+str(error),file=sys.stderr)
        raise SystemExit(1)
