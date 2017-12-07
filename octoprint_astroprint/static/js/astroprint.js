/*
 * View model for OctoPrint-AstroPrint
 *
 * Author: AstroPrint Product Team
 * License: AGPLv3
 * Copyright: 2017 3DaGoGo Inc.
 */

var astroPrintPluginStarted = false;

$(function () {

    function AstroprintViewModel(parameters) {

        var self = this;
        self.settings = parameters[0];
        self.loginState = parameters[1];
        self.astroprintUser = ko.observable(null) //null while views are being rendered
        self.designList = ko.observable([])
        self.filter = ko.observable("");
        self.isOctoprintAdmin = ko.observable(self.loginState.isAdmin());
        self.subject = ko.observable("");
        self.description = ko.observable("");
        self.access_key = ko.observable("");

        //filter Designs
        self.filteredDesigns = ko.computed(function () {
            if (!self.filter()) {
                return self.designList();
            } else {
                return ko.utils.arrayFilter(self.designList(), function (design) {
                    return design.name.indexOf(self.filter()) >= 0
                });
            }
        });

        //Pagination
        self.designsPerPage = 5; //lets show 5 design per page

        self.totalPages = ko.computed(function () {
            var pages = Math.floor(self.filteredDesigns().length / self.designsPerPage);
            pages += self.filteredDesigns().length % self.designsPerPage > 0 ? 1 : 0;
            return pages > 0 ? pages : 0
        });

        self.currentPage = ko.observable(0);

        self.filteredCurrentPage = ko.computed(function () {
            if (self.totalPages() <= self.currentPage()) {
                self.currentPage(self.totalPages());
                return self.currentPage();
            }
            if (!self.currentPage()) {
                self.currentPage(0)
            }
            return self.currentPage()
        });

        self.indexPagesToShow = ko.computed(function () {
            limitPageNumber = 5
            start = Math.max((self.filteredCurrentPage() - Math.floor(limitPageNumber / 2)), 1);
            minDesviation = (self.filteredCurrentPage() - Math.floor(limitPageNumber / 2)) > 0 ? 0 : Math.ceil(limitPageNumber / 2) - self.filteredCurrentPage()
            end = Math.min((self.filteredCurrentPage() + (Math.floor(limitPageNumber / 2) + minDesviation)), self.totalPages())
            maxDesviation = self.totalPages() - (self.filteredCurrentPage() + Math.floor(limitPageNumber / 2) + minDesviation) >= 0 ? 0 : (Math.floor(limitPageNumber / 2) - (self.totalPages() - self.filteredCurrentPage()))
            start = Math.max((self.filteredCurrentPage() - (Math.floor(limitPageNumber / 2) + maxDesviation)), 1);
            if (end < 1) {
                return ko.observable(Array(1 - start + 1).fill(start).map((a, b) => { return a + b }).filter(i => i >= start))
            }
            return ko.observable(Array(end - start + 1).fill(start).map((a, b) => { return a + b }).filter(i => i >= start))
        })

        self.changePage = function (page) {
            self.currentPage(page - 1)
        }

        self.designs = ko.computed(function () {
            var first = self.currentPage() * self.designsPerPage;
            return (self.filteredDesigns().slice(first, first + self.designsPerPage));
        });

        self.firstPage = function () {
            self.currentPage(0);
        }

        self.prevPage = function () {
            if (self.currentPage() > 0) {
                self.currentPage(self.currentPage() - 1);
            }
        }

        self.nextPage = function () {
            if (self.currentPage() < (self.totalPages() - 1)) {
                self.currentPage(self.currentPage() + 1);
            }
        }

        self.lastPage = function () {
            self.currentPage(self.totalPages() - 1);
        }

        self.designsRetrieved = ko.observable("charging") //values: charging, done, error
        self.currentUrl = window.location.href.split('?')[0];
        self.cam_status = ko.observable('charging') //null while refreshing state
        self.can_print = ko.observable(false)
        self.downloading = ko.observable(false)
        self.downloadDialog = ko.observable(new DownloadDialog) //even if serrver side can support multiple downloads, we will restric client side to just one
        self.progress = ko.observable(0)

        //DownlaodDialog model
        function DownloadDialog() {
            var self = this;
            self.id = ko.observable(null);
            self.name = ko.observable(null);
            self.image = ko.observable(null);
            self.progress = ko.observable(0);
            self.failed = ko.observable(false);
            self.downloading = ko.observable(false);
            self.file = null;
            self.fileType = null;

            self.downloadStarted = function (id, name, image, file) {
                self.id(id);
                self.name(name);
                self.image(image)
                self.progress(0);
                self.failed(false);
                self.downloading(true);
                self.file = file
            }

            self.cancelDownload = function () {
                if (self.progress() < 100) {
                    $.ajax({
                        type: "POST",
                        contentType: "application/json; charset=utf-8",
                        url: PLUGIN_BASEURL + "astroprint/canceldownload",
                        data: JSON.stringify({ 'id': self.id() }),
                        dataType: "json",
                        success: function (success) {
                            self.downloading(false);
                            self.file.downloading(false);
                            self.progress(0);
                        },
                        error: function (error) {
                            console.error("Download couldn´t be canceled");
                        }
                    });
                }
            }

            self.uploadProgress = function (id, progress) {
                if (!self.failed() && id == self.id() && self.progress() != 100) {
                    self.progress(progress);
                    if (self.progress() == 100) {
                        if (self.file.print_time) {
                            new PNotify({
                                title: gettext("File Downloaded"),
                                text: gettext("Your AstroPrint Cloud print file:" + self.name() + ", started to print."),
                                type: "success"
                            });
                        } else {
                            new PNotify({
                                title: gettext("File Downloaded"),
                                text: gettext("Your AstroPrint Cloud design:" + self.name() + ", was added to your files."),
                                type: "success"
                            });
                        }
                        self.downloading(false);
                        self.file.downloading(false);
                        self.progress(0);
                    }
                }
            }

            self.downloadFailed = function (id, message) {
                if (id == self.id) {
                    self.failed(message)
                    self.downloading(false)
                    self.file.downloading(false);
                }
            }

            self.closeDialog = function () {
                if (self.downloading() || self.failed()) {
                    self.id(null);
                    self.name(null);
                    self.progress(0);
                    self.failed(false);
                    self.downloading(false);
                }
            }
        }

        //Design model
        function Design(id, name, image, printFilesCount, allow_download) {
            var self = this;
            self.id = id;
            self.name = name;
            self.printFilesCount = ko.observable(printFilesCount);
            self.image = ko.observable("http:" + image);
            self.printFiles = ko.observableArray([]);
            self.allow_download = ko.observable(allow_download);
            self.expanded = ko.observable(false);
            self.charginPrintfiles = ko.observable(false);
            self.downloading = ko.observable(false); //values: false, 'downloading', 'error',
        }

        //PrintFile model
        function PrintFile(id, created, filename, image, sizeX, sizeY, sizeZ, print_time, layer_height, layer_count, filament_length, filament_volume, filament_weight, total_filament, format, printer, material, quality) {
            var self = this;
            self.id = id;
            self.created = moment().add(created + "Z").format("DD MMM YYYY (h:mmA)");
            self.filename = filename;
            self.image = image;
            self.sizeX = Math.round(Number(sizeX) * 100) / 100;
            self.sizeY = Math.round(Number(sizeY) * 100) / 100;
            self.sizeZ = Math.round(Number(sizeZ) * 100) / 100;
            let seconds = Number(print_time);
            let hours = Math.floor(seconds / 3600);
            let minutes = Math.floor(seconds % 3600 / 60);
            seconds = Math.floor(seconds % 3600 % 60);
            self.print_time = ((hours > 0 ? hours + ":" + (minutes < 10 ? "0" : "") : "") + minutes + ":" + (seconds < 10 ? "0" : "") + seconds);
            self.layer_height = layer_height;
            self.layer_count = layer_count;
            self.filament_length = Math.round(Number(filament_length / 10) * 100) / 100;
            self.filament_volume = Math.round(Number(filament_volume / 1000) * 100) / 100;
            self.filament_weight = Math.round(Number(filament_weight) * 100) / 100;
            self.total_filament = total_filament;
            self.format = format;
            self.printer = printer;
            self.material = material;
            self.quality = quality;
            self.expanded = ko.observable(false);
            self.downloading = ko.observable(false);
        }

        /* Event handler */
        self.onDataUpdaterPluginMessage = function (plugin, message) {
            if (plugin == "Astroprint") {
                switch (message.event) {
                    case "cameraStatus":
                        self.changeCameraStatus(message.data);
                        break;
                    case "logOut":
                        self.logOut()
                        break;
                    case "canPrint":
                        self.can_print(message.data)
                        break;
                    case "download":
                        if (message.data.progress) {
                            self.downloadDialog().uploadProgress(message.data.id, message.data.progress)
                        }
                        if (message.data.failed) {
                            self.downloadDialog().downloadFailed(message.data.id, message.data.failed)
                        }
                        break;
                    case "userLogged":
                        if (!self.isOctoprintAdmin()) {
                            logTries = 5; //handle asyncronous loggin state from octoprint
                            self.userLogged();
                        }
                        break;
                    case "userLoggedOut":
                        if (self.isOctoprintAdmin()) {
                            logOutTries = 5;
                            self.userLoggedOut();
                        }
                        break;
                    case "astroPrintUserLoggedOut":
                        if(self.astroprintUser()){
                            self.astroprintUser(false);
                        }
                    default:
                        break;
                }
            }
        }

        self.userLogged = function () {
            setTimeout(function () {
                logTries--;
                if (self.loginState.isAdmin() && !self.isOctoprintAdmin()) {
                    astroPrintPluginStarted = false
                    $("#startingUpPlugin").show();
                    $("#noAstroprintLogged").hide();
                    $("#astroPrintLogged").hide();
                    self.isOctoprintAdmin(self.loginState.isAdmin());
                    self.initialice_variables();
                } else if (logTries > 0 && !self.isOctoprintAdmin()) {
                    self.userLogged();
                }
            }, 500)
        }

        self.userLoggedOut = function () {
            logOutTries--;
            setTimeout(function () {
                if (!self.loginState.isAdmin() && self.isOctoprintAdmin()) {
                    self.isOctoprintAdmin(self.loginState.isAdmin());
                    self.astroprintUser(null);
                    self.designList([]);
                } else if (logOutTries > 0 && self.isOctoprintAdmin()) {
                    self.userLoggedOut();
                }
            }, 500)
        }

        /*  Initialice variables  */
        self.initialice_variables = function () {
            $.ajax({
                type: "GET",
                contentType: "application/json; charset=utf-8",
                url: PLUGIN_BASEURL + "astroprint/initialstate",
                success: function (data) {
                    if (data.user) {
                        self.astroprintUser(data.user)
                        self.getDesigns(false);
                    } else {
                        self.astroprintUser(false)
                    }
                    self.cam_status(data.connected)
                    self.can_print(data.can_print)
                    if (!astroPrintPluginStarted) {
                        self.showAstroPrintPages()
                    }
                },
                error: function (data) {
                    console.error(data)
                    self.astroprintUser(false) //set false?
                    self.cam_status(false)
                    self.can_print(true) // set true?
                    if (!astroPrintPluginStarted) {
                        self.showAstroPrintPages()
                    }
                },
                dataType: "json"
            });
        }


        self.changeCameraStatus = function (data) {
            self.cam_status(data)
            new PNotify({
                title: gettext(data ? "Camera detected" : "Lost camera connection"),
                text: gettext(data ? "Your Octoprint camera is connected with AstroPrint" : "AstroPrint has lost connection with the camera"),
                type: data ? "success" : "error"
            });
        }

        self.authorizeAstroprint = function () {
            if (self.access_key()){
            $.ajax({
                type: "POST",
                contentType: "application/json; charset=utf-8",
                url: PLUGIN_BASEURL + "astroprint/saveAccessKey",
                data: JSON.stringify({ access_key : self.access_key()}),
                dataType: "json",
                success: function (success) {
                    let currentUrl = window.location.href.split('?')[0];
                    let url = astroprint_variables.appSite + "/authorize" +
                        "?client_id=" + astroprint_variables.appId +
                        "&redirect_uri=" + currentUrl +
                        "&scope=profile:read project:read design:read design:download print-file:read print-file:download print-job:read device:connect"+
                        "&response_type=code"
                    location.href = url;
                },
                error: function (error) {
                    new PNotify({
                        title: gettext("Login error"),
                        text: gettext("There was an error trying to log in, please try again"),
                        type: "error"
                    });
                }
            });
            } else {
                new PNotify({
                    title: gettext("Missing Access Key"),
                    text: gettext("Access Key is missing, please provide a valid one"),
                    type: "error"
                });
            }
        }

        self.logAstroprint = function (accessCode) {
            let currentUrl = window.location.href.split('?')[0];
            $.ajax({
                type: "POST",
                contentType: "application/json; charset=utf-8",
                url: PLUGIN_BASEURL + "astroprint/loggin",
                data: JSON.stringify({ code: accessCode, url: currentUrl }),
                dataType: "json",
                success: function (success) {
                    self.astroprintUser(success);
                    self.getDesigns(false);
                    new PNotify({
                        title: gettext("AstroPrint Login successful"),
                        text: gettext("You are now logged to Astroprint as " + self.astroprintUser().email),
                        type: "success"
                    });
                },
                error: function (error) {
                    new PNotify({
                        title: gettext("Login falied: " + error.responseJSON.error),
                        text: gettext(error.responseJSON.error_description),
                        type: "error"
                    });
                }
            });
        }

        self.logOutAstroPrint = function () {
            self.logOut().then(function (success) {
                new PNotify({
                    title: gettext("AstroPrint Logout successful"),
                    text: gettext("You are now logged out of AstroPrint"),
                    type: "success"
                });
            }, function (error) {
                new PNotify({
                    title: gettext("AstroPrint Logout failed"),
                    text: gettext("There was an error logging out of AstroPrint."),
                    type: "error"
                });
            });
        };

        //Send from event (user allready has benn deleted from database)
        self.error401handeler = function () {
            self.astroprintUser(false);
            new PNotify({
                title: gettext("AstroPrint session expired"),
                text: gettext("Your AstroPrint session has expired, please log again."),
                type: "error"
            });
        }

        //Only case we logout and we have to delete user, from client side
        self.logOut = function () {
            return new Promise(function (resolve, reject) {
                $.ajax({
                    type: "POST",
                    contentType: "application/json; charset=utf-8",
                    url: PLUGIN_BASEURL + "astroprint/logout",
                    dataType: "json",
                    success: function () {
                        self.astroprintUser(false);
                        resolve();
                    },
                    error: function () {
                        reject();
                    }
                });
            });
        }


        $('#astroPrintModal').on('hidden', function () {
            self.description("");
            self.subject("");
        })


        self.getDesigns = function (refresh = true) {
            self.designsRetrieved("charging");
            $.ajax({
                type: "GET",
                contentType: "application/json; charset=utf-8",
                url: PLUGIN_BASEURL + "astroprint/designs",
                start_time: new Date().getTime(),
                success: function (data) {
                    designs = [];
                    for (design of data.data) {
                        designs.push(
                            new Design(design.id, design.name, design.images.square, design.print_file_count, design.allow_download)
                        );
                    }
                    self.designList(designs);
                    let notify = function () {
                        new PNotify({
                            title: gettext("AstroPrint Designs Retrieved"),
                            text: gettext("Your designs and print files from AstroPrint have been refreshed"),
                            type: "success"
                        });
                    }
                    if ((new Date().getTime() - this.start_time) > 600) {
                        self.designsRetrieved("done");
                        if (refresh) {
                            notify();
                        }
                    } else {
                        setTimeout(function () {
                            self.designsRetrieved("done");
                            if (refresh) {
                                notify();
                            }
                        }, 600 - ((new Date().getTime() - this.start_time)));
                    }
                },
                error: function (data) {
                    if (data.status == 401) {
                        self.error401handeler();
                    } else {
                        self.designsRetrieved("error");
                        new PNotify({
                            title: gettext("Error retrievind designs"),
                            text: gettext("There was an error retrieving AstroPrint desings, please try again later."),
                            type: "error"
                        });
                    }
                },
                dataType: "json"
            });
        };

        self.getPrintFiles = function (design) {
            if (design.printFilesCount()) {
                if (design.expanded()) {
                    design.expanded(false);
                } else {
                    if (!design.charginPrintfiles()) {
                        if (design.printFiles().length == 0) {
                            design.charginPrintfiles(true);
                            $.ajax({
                                type: "GET",
                                contentType: "application/json; charset=utf-8",
                                url: PLUGIN_BASEURL + "astroprint/printfiles",
                                data: {
                                    designId: design.id
                                },
                                start_time: new Date().getTime(),
                                success: function (data) {
                                    printFiles = [];
                                    for (p of data.data) {
                                        printFiles.push(
                                            new PrintFile(p.id, p.created, p.filename, design.image, p.info.size.x, p.info.size.y, p.info.size.z, p.info.print_time, p.info.layer_height, p.info.layer_count, p.info.filament_length, p.info.filament_volume, p.info.filament_weight, p.info.total_filament, p.format, p.printer.name, p.material.name, p.quality)
                                        );
                                    }
                                    design.printFilesCount(printFiles.length);
                                    design.printFiles(printFiles);
                                    design.charginPrintfiles(false);
                                    design.expanded(true);
                                },
                                error: function (data) {
                                    if (data.status == 401) {
                                        self.error401handeler();
                                    } else {
                                        design.charginPrintfiles(false);
                                        new PNotify({
                                            title: gettext("Error retrieving Print Files"),
                                            text: gettext("There was an error retrieving print files, please try again later."),
                                            type: "error"
                                        });
                                    }
                                },
                                dataType: "json"
                            });
                        } else {
                            design.expanded(true);
                        }
                    }
                }
            }
        }

        self.expandPrintfile = function (printFile) {
            if (printFile.expanded()) {
                printFile.expanded(false);
            } else {
                printFile.expanded(true);
            }
        }

        self.downloadDesign = function (design) {
            if (self.isOctoprintAdmin()) {
                if (!self.downloadDialog().downloading() || self.downloadDialog().progress() == 100) {
                    name = design.name
                    if (name.toLowerCase().substr(name.lastIndexOf('.') + 1, 3) != 'stl') {
                        name += '.stl';
                    }
                    design.downloading(true);
                    $.ajax({
                        type: "POST",
                        contentType: "application/json; charset=utf-8",
                        url: PLUGIN_BASEURL + "astroprint/downloadDesign",
                        data: JSON.stringify({ designId: design.id, name: name }),
                        dataType: "json",
                        success: function (data) {
                            self.downloadDialog().downloadStarted(design.id, design.name, design.image, design)
                        },
                        error: function (error) {
                            if (error.status == 401) {
                                self.error401handeler();
                            } else {
                                design.downloading(false);
                                let text = "There was an error retrieving design, please try again later.";
                                let title = "Error retrieving Design";
                                if (error.status == 400) {
                                    title = ("Error adding Design");
                                    text = error.responseText;
                                }
                                new PNotify({
                                    title: gettext(title),
                                    text: gettext(text),
                                    type: "error"
                                });
                            }
                        }
                    });
                }
            } else {
                new PNotify({
                    title: gettext("Please log in"),
                    text: gettext("You must be logged onto your OctoPrint Account to be able to download designs."),
                    type: "info"
                });
            }
        }

        self.downloadPrintFile = function (printFile) {
            if (self.isOctoprintAdmin()) {
                if (!self.downloadDialog().downloading() || self.downloadDialog().progress() == 100) {
                    printFile.downloading(true);
                    $.ajax({
                        type: "POST",
                        contentType: "application/json; charset=utf-8",
                        url: PLUGIN_BASEURL + "astroprint/downloadPrintFile",
                        data: JSON.stringify({ printFileId: printFile.id, name: printFile.filename }),
                        dataType: "text",
                        success: function (data) {
                            data = JSON.parse(data)
                            if (data['state'] == "downloading") {
                                self.downloadDialog().downloadStarted(printFile.id, printFile.filename, printFile.image, printFile);
                            } else {
                                self.downloadDialog().downloadStarted(printFile.id, printFile.filename, printFile.image, printFile);
                                self.downloadDialog().uploadProgress(printFile.id, 100);
                            }
                        },
                        error: function (error) {
                            if (error.status == 401) {
                                self.error401handeler();
                            } else {
                                printFile.downloading(false);
                                let text = "There was an error retrieving design, please try again later.";
                                let title = "Error retrieving Design";
                                if (error.status == 400) {
                                    title = ("Error adding Design");
                                    text = error.responseText;
                                }
                                new PNotify({
                                    title: gettext(title),
                                    text: gettext(text),
                                    type: "error"
                                });
                            }

                        }
                    });
                }
            } else {
                new PNotify({
                    title: gettext("Please log in"),
                    text: gettext("You must be logged on your OctoPrint Account to be able to download print files."),
                    type: "info"
                });
            }
        }

        self.scanForCamera = function () {
            if (!self.cam_status()) {//loading could be confused when camera is active
                self.cam_status('charging');
            }
            $.ajax({
                type: "GET",
                contentType: "application/json; charset=utf-8",
                start_time: new Date().getTime(),
                url: PLUGIN_BASEURL + "astroprint/checkcamerastatus",
                start_time: new Date().getTime(),
                success: function (data) {
                    if ((new Date().getTime() - this.start_time) > 800) { //give some time to make the user sure that it really looked for cam
                        self.cam_status(data.connected)
                    } else {
                        setTimeout(function () {
                            self.cam_status(data.connected)
                        }, 800 - ((new Date().getTime() - this.start_time)));
                    }
                },
                error: function (data) {
                    self.cam_status(false)//set false?
                },
                dataType: "json"
            });
        };

        //handle asyncronous loggin state from octoprint
        self.checkIsLoggedOnConnect = function () {
            setTimeout(function () {
                self.isOctoprintAdmin(self.loginState.isAdmin())
                if (self.isOctoprintAdmin()) {
                    self.initialice_variables();
                } else {
                    self.showAstroPrintPages();
                }
            }, 100);
        };

        self.checkApiOption = function () {
            $('#navbar_show_settings').trigger( "click" );
            $('#settingsTabs a[href="#settings_plugin_astroprint"]').tab('show')
            setTimeout( ()=>{
                document.getElementById('goToastrocors').click();
            }, 200)
        }

        self.showAstroPrintPages = function () {
            $("#startingUpPlugin").hide()
            $("#noOctoprintLogged").show();
            $("#noAstroprintLogged").show();
            $("#astroPrintLogged").show();
            astroPrintPluginStarted = true;
        }

        //log with the code
        self._getUrlParameter = function (sParam) {
            var sPageURL = decodeURIComponent(window.location.search.substring(1)),
                sURLVariables = sPageURL.split('&'),
                sParameterName,
                i;

            for (i = 0; i < sURLVariables.length; i++) {
                sParameterName = sURLVariables[i].split('=');
                if (sParameterName[0] === sParam) {
                    return sParameterName[1] === undefined ? true : sParameterName[1];
                }
            }
        };

        //Log in before startupComplete saves some time
        let code = self._getUrlParameter("code");
        if (code) {
            self.logAstroprint(code);
            window.history.replaceState({}, document.title, "/");
        }

        self.onStartupComplete = function () {
            setTimeout(self.checkIsLoggedOnConnect(), 1000);
        }

        self.moveToApi = function (){
            $('#settingsTabs a[href="#settings_api"]').tab('show')
            $('#settings-apiCors').closest("label").animate({fontSize : "18px"}, 1000 ).animate({fontSize : "15px"}, 1000 )
        }

    }

    // view model class, parameters for constructor, container to bind to
    OCTOPRINT_VIEWMODELS.push([
        AstroprintViewModel,
        ["settingsViewModel", "loginStateViewModel"],
        ["#settings_plugin_astroprint", "#tab_plugin_astroprint"]
    ]);
});