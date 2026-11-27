import json, pathlib, re, shlex, subprocess, tempfile, sys
root=pathlib.Path.cwd()
out=root/"audit-results"
out.mkdir(exist_ok=True)
db=json.loads((root/"build-native/cmake/pando-core/compile_commands.json").read_text())
names=r"\b(?:JobScheduler|JobToken|JobTicket|JobStats|JobStop|JobDisposition|jobDispositionCode|endpointValue|validityValue|readGeometryProvenance|TimelineChangePeriod|timelineChangePeriods|snapshotTimelineStorage|admitExternalBaseline)\b"
target=re.compile(names)
decl=re.compile(r"\b(?:FunctionDecl|CXXMethodDecl|CXXConstructorDecl|CXXDestructorDecl|VarDecl|EnumDecl|CXXRecordDecl)\b")
reference=re.compile(r"\b(?:DeclRefExpr|MemberExpr)\b")
rows=[]
for entry in db:
    args=entry.get("arguments") or shlex.split(entry["command"])
    clean=[]; i=0
    while i<len(args):
        a=args[i]
        if a in ("-o","-MF","-MT","-MQ"): i+=2;continue
        if a in ("-c","-MD","-MMD","-MP"): i+=1;continue
        clean.append(a);i+=1
    clean += ["-fsyntax-only","-Xclang","-ast-dump","-Xclang","-ast-dump-filter=pandoeditor"]
    hits=[]; declarations=0; references=0
    with tempfile.TemporaryFile(mode="w+") as err:
        p=subprocess.Popen(clean,cwd=entry["directory"],stdout=subprocess.PIPE,stderr=err,text=True,errors="replace")
        for line in p.stdout:
            declarations+=bool(decl.search(line));references+=bool(reference.search(line))
            if target.search(line):hits.append(line.strip()[:500])
        code=p.wait();err.seek(0);errors=err.read() if code else ""
    rows.append({"file":str(pathlib.Path(entry["file"]).relative_to(root)),"returncode":code,"declarationNodes":declarations,"referenceNodes":references,"retiredSymbolNodes":hits,"errors":errors[-5000:]})
    print(rows[-1]["file"],"AST exit",code,"declarations",declarations,"references",references,"retired hits",len(hits),flush=True)
archive=list((root/"build-native/cmake/pando-core").rglob("libpandoeditor_core.a"))
if len(archive)!=1:raise RuntimeError("Expected one native core archive")
defined=subprocess.check_output(["nm","-C","--defined-only",str(archive[0])],text=True,errors="replace")
undefined=subprocess.check_output(["nm","-C","--undefined-only",str(archive[0])],text=True,errors="replace")
(out/"native-defined-symbols.txt").write_text(defined)
(out/"native-undefined-symbols.txt").write_text(undefined)
retired_defs=[l for l in defined.splitlines() if target.search(l)]
retired_refs=[l for l in undefined.splitlines() if target.search(l)]
summary={"translationUnits":len(rows),"astFailures":sum(r["returncode"]!=0 for r in rows),"astRetiredHits":sum(len(r["retiredSymbolNodes"]) for r in rows),"definedRetiredSymbols":retired_defs,"undefinedRetiredSymbols":retired_refs,"rows":rows}
(out/"native-ast.json").write_text(json.dumps(summary,indent=2)+"\n")
print(json.dumps({k:v for k,v in summary.items() if k!="rows"},indent=2),flush=True)
if summary["astFailures"] or summary["astRetiredHits"] or retired_defs or retired_refs:sys.exit(1)
