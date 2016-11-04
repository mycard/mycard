import {Injectable, ApplicationRef} from "@angular/core";
import {Http} from "@angular/http";
import {App, AppStatus} from "./app";
import {InstallConfig} from "./install-config";
import {SettingsService} from "./settings.sevices";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as mkdirp from "mkdirp";
import * as child_process from "child_process";
import {remote} from "electron";
import "rxjs/Rx";
import {AppLocal} from "./app-local";


const Aria2 = require('aria2');
const Sudo = require('electron-sudo').default;

Sudo.prototype.fork = function (modulePath, args, options) {
    return this.spawn(remote.app.getPath('exe'), ['-e', modulePath].concat(args), options).then((child)=> {
        readline.createInterface({input: child.stdout}).on('line', (line) => {
            child.emit('message', JSON.parse(line));
        });
        child.send = (message, sendHandle, options, callback)=> {
            child.stdin.write(JSON.stringify(message) + os.EOL);
            if (callback) {
                callback()
            }
        };
        return child
    })
};

@Injectable()
export class AppsService {

    constructor(private http: Http, private settingsService: SettingsService, private ref: ApplicationRef,) {
    }


    // get allApps(): Map<string,App> {
    //     return this.data;
    // }

    //[{"id": "th01", "gid": "aria2gid", "status": "active/install/complete/wait", "progress": "0-100"}]
    downloadsInfo = [];

    //[{"id": "th01", "wait":["wine", "dx"], resolve: resolve, tarObj: tarObj}]
    // th01
    waitInstallQueue = [];


    aria2IsOpen = false;


    _aria2;
    get aria2() {
        if (!this._aria2) {
            this._aria2 = new Aria2();
            console.log("new aria2");
            this._aria2.onopen = ()=> {
                console.log('aria2 open');
            };
            this._aria2.onclose = ()=> {
                console.log('aria2 close');
                this.aria2IsOpen = false;
            };
            this._aria2.onDownloadComplete = (response)=> {
                console.log("download response: ", response);
                this._aria2.tellStatus(response.gid, (err, res)=> {
                    let index = this.downloadsInfo.findIndex((v)=> {
                        return v.gid == res.gid
                    });
                    if (index !== -1) {
                        if (res.followedBy) {
                            this.downloadsInfo[index].gid = res.followedBy[0];
                            this.downloadsInfo[index].progress = 0;

                        } else {
                            this.downloadsInfo[index].status = "wait";
                            let tarObj = {
                                id: this.downloadsInfo[index].id,
                                xzFile: res.files[0].path,
                                // installDir: this.installConfig.installLibrary
                            };
                            new Promise((resolve)=> {
                                // let refs = this.searchApp(this.downloadsInfo[index].id).references;
                                // console.log(refs);
                                //[{"id": "th01", "wait":["wine", "dx"], resolve: resolve, tarObj: tarObj}]
                                let waitObj;

                                // TODO 重写依赖的安装
                                // let waitRef = ["runtime", "emulator", "dependency"];
                                // if (!this.isEmptyObject(refs)) {
                                //     refs[process.platform].map((ref)=> {
                                //         if (waitRef.includes(ref.type)) {
                                //             if (!this.checkInstall(ref.id)) {
                                //                 if (!waitObj) {
                                //                     waitObj = {
                                //                         id: this.downloadsInfo[index].id,
                                //                         wait: [ref.id],
                                //                         resolve: resolve,
                                //                         tarObj: tarObj
                                //                     }
                                //                 } else {
                                //                     waitObj.wait.push(ref.id);
                                //                 }
                                //             }
                                //         }
                                //     });
                                // }
                                // console.log("wait obj:", waitObj);

                                if (waitObj) {
                                    this.waitInstallQueue.push(waitObj);
                                } else {
                                    resolve();
                                }

                            }).then(()=> {
                                console.log(tarObj);
                                this.tarPush(tarObj);
                            });
                            // promise.catch((err)=> {
                            //     err.printt
                            // })
                        }
                    } else {
                        console.log("cannot found download info!");
                    }
                });
            };
            //this._aria2.onmessage = (m)=> {
            //console.log('IN:', m);
            //console.log('download infoi:', this.downloadsInfo);

            //}
        }

        if (!this.aria2IsOpen) {
            this._aria2.open().then(()=> {
                console.log('aria2 websocket open');
                this.aria2IsOpen = true;
            });
        }

        return this._aria2;

    }

    //_download_dir;
    get download_dir() {
        const dir = path.join(remote.app.getAppPath(), 'cache');

        if (!fs.existsSync(dir)) {
            console.log('cache not exists');
            mkdirp(dir, (err)=> {
                if (err) {
                    console.error(err)
                } else {
                    console.log('create cache dir');
                }
            });
        }

        return dir;
    }

    loadApps() {
        return this.http.get('./apps.json')
            .toPromise()
            .then((response)=> {
                let data = response.json();
                return this.loadAppsList(data);
            });
    }

    loadAppsList = (data: any): Map<string,App> => {
        let apps = new Map<string,App>();
        let locale = this.settingsService.getLocale();
        let platform = process.platform;

        for (let item of data) {
            let app = new App(item);
            let local = localStorage.getItem(app.id);
            if (local) {
                app.local = new AppLocal();
                app.local.update(JSON.parse(local));
            }
            app.status = new AppStatus();
            if (local) {
                app.status.status = "ready";
            } else {
                app.status.status = "init";
            }

            // 去除无关语言
            ['name', 'description'].forEach((key)=> {
                let value = app[key][locale];
                if (!value) {
                    value = app[key]["en-US"];
                }
                app[key] = value;
            });

            // 去除平台无关的内容
            ['actions', 'dependencies', 'references', 'download', 'version'].forEach((key)=> {
                if (app[key]) {
                    if (app[key][platform]) {
                        app[key] = app[key][platform];
                    }
                    else {
                        app[key] = null;
                    }
                }
            });
            apps.set(item.id, app);

        }

        // 设置App关系
        for (let id of Array.from(apps.keys())) {
            let temp = apps.get(id)["actions"];
            let map = new Map<string,any>();
            for (let action of Object.keys(temp)) {
                let openId = temp[action]["open"];
                if (openId) {
                    temp[action]["open"] = apps.get(openId);
                }
                map.set(action, temp[action]);
            }
            apps.get(id).actions = map;

            ['dependencies', 'references', 'parent'].forEach((key)=> {
                let app = apps.get(id);
                let value = app[key];
                if (value) {
                    if (Array.isArray(value)) {
                        let map = new Map<string,App>();
                        value.forEach((appId, index, array)=> {
                            map.set(appId, apps.get(appId));
                        });
                        app[key] = map;
                    } else {
                        app[key] = apps.get(value);
                    }
                }
            });
        }
        return apps;
    };


    deleteFile(path: string): Promise<string> {
        return new Promise((resolve, reject)=> {
            fs.lstat(path, (err, stats)=> {
                if (err) return resolve(path);
                if (stats.isDirectory()) {
                    fs.rmdir(path, (err)=> {
                        resolve(path);
                    });
                } else {
                    fs.unlink(path, (err)=> {
                        resolve(path);
                    });
                }
            });
        })
    }

    saveAppLocal(app: App, appLocal: AppLocal) {
        localStorage.setItem(app.id, JSON.stringify(appLocal));
    }

    install(config: InstallConfig) {
        let app = config.app;
    }

    uninstall(id: string) {
        // //let current = this;
        // if (this.checkInstall(id)) {
        //     let files: string[] = this.searchApp(id).local.files.sort().reverse();
        //     // 删除本目录
        //     files.push('.');
        //     let install_dir = this.searchApp(id).local.path;
        //     return files
        //         .map((file)=>
        //             ()=>path.join(install_dir, file)
        //         )
        //         .reduce((promise: Promise<string>, task)=>
        //                 promise.then(task).then(this.deleteFile)
        //             , Promise.resolve(''))
        //         .then((value)=> {
        //             this.searchApp(id).local = null;
        //             localStorage.setItem("localAppData", JSON.stringify(this.data));
        //             return Promise.resolve()
        //         });
        // }

    }

    download() {
        // let id = this.currentApp.id;
        // if (this.downloadsInfo.findIndex((v)=> {
        //         return v.id == id
        //     }) !== -1) {
        //     console.log("this app is downloading")
        // } else {
        //     let url = this.currentApp.download;
        //     this.aria2.addUri([url], {'dir': this.download_dir}, (error, gid)=> {
        //         console.log(error, gid);
        //         if (error) {
        //             console.error(error);
        //         }
        //         this.downloadsInfo.push({"id": id, "gid": gid, "status": "active", "progress": 0});
        //     });
        // }
    }

    getDownloadInfo(id) {
        let info;
        info = this.downloadsInfo.find((v)=> {
            return v.id == id;
        });

        return info;
    }


    // tar
    tarQueue = [];
    isExtracting = false;

    tarPush(tarObj) {
        this.tarQueue.push(tarObj);

        if (this.tarQueue.length > 0 && !this.isExtracting) {
            this.doTar();
        }

    }

    doTar() {
        let tarPath;
        switch (process.platform) {
            case 'win32':
                tarPath = path.join(process.execPath, '..', '../../../bin/', 'tar.exe');
                break;
            case 'darwin':
                tarPath = 'bsdtar'; // for debug
                break;
            default:
                throw 'unsupported platform';
        }
        let opt = {
            maxBuffer: 20 * 1024 * 1024
        };

        let tarObj;
        if (this.tarQueue.length > 0) {
            tarObj = this.tarQueue[0];
        } else {
            console.log("Empty Queue!");

            return;
        }

        this.isExtracting = true;
        console.log("Start tar " + tarObj.id);

        let downLoadsInfoIndex = this.downloadsInfo.findIndex((v)=> {
            return v.id == tarObj.id
        });
        if (downLoadsInfoIndex !== -1) {
            this.downloadsInfo[downLoadsInfoIndex].status = "install";
        } else {
            console.log("cannot found download info!");
        }


        let xzFile = tarObj.xzFile;
        let installDir = path.join(tarObj.installDir, tarObj.id);
        if (!fs.existsSync(installDir)) {
            console.log('app dir not exists');
            mkdirp(installDir, (err)=> {
                if (err) {
                    console.error(err)
                } else {
                    console.log('create app dir');
                }
            });
        }

        let tar = child_process.execFile(tarPath, ['xvf', xzFile, '-C', installDir], opt, (err, stdout, stderr)=> {
            if (err) {
                throw err;
            }

            let logArr = stderr.toString().trim().split("\n")
                .map((log, index, array)=> {
                    return log.split(" ", 2)[1];
                });

            let appLocal = {
                id: tarObj.id,
                local: {
                    path: installDir,
                    version: "0.1",
                    files: logArr
                }
            };

            let localAppData = JSON.parse(localStorage.getItem("localAppData"));
            if (!localAppData || !Array.isArray(localAppData)) {
                localAppData = [];
            }

            let index = localAppData.findIndex((v)=> {
                return v.id == tarObj.id;
            });
            if (index === -1) {
                localAppData.push(appLocal);
            } else {
                localAppData[index] = appLocal;
            }
            localStorage.setItem("localAppData", JSON.stringify(localAppData));

            let tmp = this.tarQueue.shift();
            this.isExtracting = false;
            this.downloadsInfo[downLoadsInfoIndex].status = "complete";
            // 为了卸载时能重新显示安装条
            this.downloadsInfo.splice(downLoadsInfoIndex, 1);
            // this.data.get(tarObj.id).local = appLocal.local;
            // console.log(11111, this.data.get(tarObj.id), appLocal);

            //[{"id": "th01", "wait":["wine", "dx"], resolve: resolve, tarObj: tarObj}]
            this.waitInstallQueue = this.waitInstallQueue.map((waitObj)=> {
                waitObj.wait.splice(waitObj.wait.findIndex(()=>tarObj.id), 1);
                if (waitObj.wait.length <= 0) {
                    waitObj.resolve();
                    console.log(tarObj);
                    return;
                } else {
                    return waitObj;
                }
            });
            this.waitInstallQueue = this.waitInstallQueue.filter((waitObj)=> {
                return waitObj
            });

            console.log(tmp);
            console.log("this app complete!");
            console.log(localAppData);

            this.doTar();

        });

    }

    browse(app: App) {
        remote.shell.showItemInFolder(app.local.path);
    }

    connections = new Map<App, {connection: WebSocket, address: string}>();
    maotama;

    network(app: App, server) {
        if (!this.maotama) {
            this.maotama = new Sudo({name: 'MyCard'}).fork('maotama')
        }
        this.maotama.then((child)=> {
            let connection = this.connections.get(app);
            if (connection) {
                connection.connection.close();
            }
            connection = {connection: new WebSocket(server.url), address: null};
            let id;
            this.connections.set(app, connection);
            connection.connection.onmessage = (event)=> {
                console.log(event.data);
                let [action, args] = event.data.split(' ', 2);
                let [address, port] = args.split(':');
                switch (action) {
                    case 'LISTEN':
                        connection.address = args;
                        this.ref.tick();
                        break;
                    case 'CONNECT':
                        id = setInterval(()=> {
                            child.send({
                                action: 'connect',
                                arguments: [app.network.port, port, address]
                            })
                        }, 200);
                        break;
                    case 'CONNECTED':
                        clearInterval(id);
                        id = null;
                        break;
                }
            };
            connection.connection.onclose = (event: CloseEvent)=> {
                if (id) {
                    clearInterval(id);
                }
                // 如果还是在界面上显示的那个连接
                if (this.connections.get(app) == connection) {
                    this.connections.delete(app);
                    if (event.code != 1000 && !connection.address) {
                        alert(`出错了 ${event.code}`);
                    }
                }
                // 如果还没建立好就出错了，就弹窗提示这个错误
                this.ref.tick();
            };
        })
    }
}