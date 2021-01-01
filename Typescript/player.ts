import { TranslateService } from "./../../../xplat/core/services/translate.service";
import {
  AppPhoneNumber,
  PhoneCallService,
} from "@pnp/features/shared/services/phone-call.service";

import {
  AppPersoItem,
  AppSharedPersoItem,
  PersoItemService,
} from "@pnp/features/shared/services/perso-item.service";
import {
  BaseComponent,
  ModalActions,
  PersoItemActions,
  PusherEvents,
  PusherService,
  RouterActions,
  UserService,
  UserState,
  WindowService,
} from "@pnp/features";

import { DOCUMENT } from "@angular/common";
import { Component, Inject, OnInit } from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import { select, Store } from "@ngrx/store";
import { User } from "@pnp/api";
import { environment } from "@pnp/core/environments/environment";
import { getUrlFromFragment } from "@pnp/utils";
import {
  BehaviorSubject,
  combineLatest,
  Observable,
  of,
  Subject,
  throwError,
} from "rxjs";
import {
  catchError,
  delay,
  filter,
  map,
  switchMap,
  take,
  takeUntil,
} from "rxjs/operators";
import { VgAPI } from "ngx-videogular";

import {
  Flattening,
  FlatteningType,
  FlattenPersoItemResponse,
  PersoItem,
  UrlFragment,
} from "@pnp/sdk";
import { FacebookService } from "src/app/xplat/core/services/facebook.service";
import { MetaTagsService } from "src/app/xplat/core/services/meta-tags.service";
import { InfoMessagesService } from "src/app/xplat/core/services/info-messages.service";
import {
  AuthModalTypes,
  WebHelperService,
} from "src/app/xplat/core/services/web-helper.service";
import { PurchaseModalService } from "src/app/xplat/core/services/purchase-modal.service";
import {
  PlaceCallModalComponent,
  PlaceModalType,
} from "src/app/features/shared/place-call-modal/place-call-modal.component";
import { AngularFireAnalytics } from "@angular/fire/analytics";
import { ShareWebsiteModalComponent } from "../../my-items/modals/share-website-modal/share-website-modal.component";
import { ShareVideoModalComponent } from "../../my-items/modals/share-video-modal/share-video-modal.component";

export interface IMultiVideo {
  multiVideoAssets?: Flattening.MultiVideoAssets.AsObject;
  multiVideo?: PersoItem.MultiVideo.AsObject;
}

export enum MultiVideoPlayStatus {
  INTRO_START = 0,
  CHOSES_START = 1,
  ZONE_START = 2,
  OUTRO_START = 3,
}

export interface MultiVideoPlay {
  zoneIndex?: number;
  videoPlayerStatus: MultiVideoPlayStatus;
}

@Component({
  templateUrl: "./player.component.html",
})
export class PlayerComponent extends BasePlayerComponent implements OnInit {
  myVideo: AppPersoItem;
  isKidPlayer$: Observable<boolean>;
  currentStatus: Flattening.Status;
  showButtons: boolean;
  showZones = false;
  vgApi: VgAPI;
  flattening: Flattening.AsObject;
  assetKeys: Array<string>;
  startVideo: HTMLVideoElement;
  answeredVideo: HTMLVideoElement;
  incompleteVideo: HTMLVideoElement;
  user: User;
  isVideoOwner = false;
  canDownloadVideo = false;
  showRRPrompt = false;
  isPlayerReady = new BehaviorSubject(false);
  isMyVideoReady = new BehaviorSubject(false);
  persoItemMainUrl: string;
  multiDeviceUrls: Flattening.MultiDeviceAssets.AsObject;
  mv: IMultiVideo = {};
  persoItemThumbUrl: string;
  persoItemToken: string;
  multiVideoStatusChange = new Subject<MultiVideoPlay>();
  showOverlayPlay = true;
  playerQueryParameters: any;
  videoId: number;
  userTokenProccessInit = false;

  isFree$ = this._userService.isFreeUser();

  get multiVideoStatusChange$() {
    return this.multiVideoStatusChange.asObservable();
  }

  public flattenStatus = Flattening.Status;

  sharedPersoItem: AppSharedPersoItem;
  abuseLink: string;

  // Dependency Injection
  constructor(
    private _store: Store<any>,
    private _fb: FacebookService,
    private _win: WindowService,
    private _metaTagsService: MetaTagsService,
    private _infoMessages: InfoMessagesService,
    public webHelper: WebHelperService,
    public route: ActivatedRoute,
    private _analytics: AngularFireAnalytics,
    private _purchaseModal: PurchaseModalService,
    private _userService: UserService,
    private _persoItemService: PersoItemService,
    private _pusherService: PusherService,
    private _phoneCallService: PhoneCallService,
    private translateService: TranslateService,
    @Inject(DOCUMENT)
    private _document
  ) {
    super();

    //  Prevent right clicks to prevent downloading the video
    this._win.oncontextmenu = (event) => {
      event.stopPropagation();
      event.preventDefault();
    };
  }

  ngOnInit() {
    this.isKidPlayer$ = this.route.data.pipe(map((d) => d.isKid));
    this.initMultiVideoProccess();
    this._initFB();
    this._initVideo();
    this._initMeta();
    this._handleKidPlayer();
    this.abuseLink = `https://portablenorthpole.zendesk.com/hc/${this.translateService.locale.code}/requests/new?session_id=None&ticket_form_id=161083`;
  }

  getMediaUrl(fragmnet: UrlFragment.AsObject) {
    return getUrlFromFragment(fragmnet);
  }
  getCords(zone: any) {
    return {
      left: zone.topLeft.x + "%",
      top: zone.topLeft.y + "%",
      width: zone.bottomRight.x + "%",
      height: zone.bottomRight.y + "%",
    };
  }
  openShareVideoModal() {
    this._store.dispatch(
      new ModalActions.OpenAction({
        cmpType: ShareVideoModalComponent,
        props: {
          trackTitle: "Share video",
          video: this.myVideo,
        },
      })
    );
  }

  openShareWebsiteModal() {
    this._store.dispatch(
      new ModalActions.OpenAction({
        cmpType: ShareWebsiteModalComponent,
        props: {
          trackTitle: "Share website",
        },
      })
    );
  }

  replayVideo() {
    this.vgApi.play();
    this.showButtons = false;
  }

  onPlayerReady(api: VgAPI) {
    this.vgApi = api;
    this.isPlayerReady.next(true);
    this.isPlayerReady.complete();

    this.vgApi
      .getDefaultMedia()
      .subscriptions.play.pipe(takeUntil(this.destroy$))
      .subscribe((_) => {
        this.viewIncrementLog();
      });

    this.vgApi
      .getDefaultMedia()
      .subscriptions.ended.pipe(takeUntil(this.destroy$))
      .subscribe((_) => {
        this.showButtons =
          this.isVideoOwner &&
          this.myVideo.type !== PersoItem.Type.MULTI_DEVICE &&
          this.myVideo.type !== PersoItem.Type.MULTI_VIDEO;
      });
  }

  createAnother() {
    this.webHelper.localizeRoute("santa-video");
  }

  download(productCode: string) {
    if (!this._userService.isAuthenticated()) {
      this.webHelper.openAuthModal(AuthModalTypes.PURCHASE, {
        closable: true,
        productCode,
        redirectAfterPurchaseSuccess: this.webHelper.getLocalizeRoute(
          "santa-video"
        ).path,
      });
    } else {
      this._purchaseModal.open(productCode, undefined, undefined, "/my-items");
    }
  }
  zoneSelect(zoneIndex: number) {
    const multiVideoPlay = {
      zoneIndex,
      videoPlayerStatus: MultiVideoPlayStatus.ZONE_START,
    };
    this.showZones = false;
    this.multiVideoStatusChange.next(multiVideoPlay);
  }

  private _initFB() {
    if (this._win.isBrowser) {
      this._fb.init({
        appId: environment.facebook.app_id,
        xfbml: true,
        // Done here for COPPA compliance
        kidDirectedSite: true,
        version: environment.facebook.version,
      });
    }
  }

  private _initVideo() {
    this.currentStatus = Flattening.Status.IN_PROGRESS;
    this.route.queryParams
      .pipe(takeUntil(this.destroy$))
      .subscribe((params) => {
        this.playerQueryParameters = params;
        if (params?.token) {
          this._initTokenProccess(params?.token);
        } else if (params?.id && !isNaN(params?.id)) {
          this._initUserVideo(params?.id);
          this.videoId = this.videoId = +params?.id;
        } else {
          this.currentStatus = Flattening.Status.ERROR;
        }
      });
  }
  private _initTokenProccess(token: any) {
    this.persoItemToken = token;

    // Check token
    if (!token.match(/^[a-z0-9\-_]+$/i)) {
      this.currentStatus = Flattening.Status.ERROR;
      return;
    }

    this._persoItemService
      .getSharedPersoItem(token)
      .pipe(
        switchMap((sharedPersoItem: AppSharedPersoItem) => {
          this.sharedPersoItem = sharedPersoItem;
          this.videoId = sharedPersoItem.persoItemId;
          return this.isOwner(sharedPersoItem.persoItemId);
        }),
        switchMap((isOwner) => {
          if (isOwner) {
            this._setUserVideo(this.myVideo);
            return of(null);
          } else {
            if (this.sharedPersoItem?.flattening?.multiVideoAssets) {
              this.webHelper.openAuthModal(AuthModalTypes.DEFAULT, {
                closable: this.playerQueryParameters?.login === "s",
                loginMethod: "email",
                email: this.playerQueryParameters?.email,
              });
              return this._store.pipe(
                select(UserState.selectCurrent),
                filter((x) => !!x),
                takeUntil(this.destroy$)
              );
            } else {
              this._setVisitorVideo();
              return of(null);
            }
          }
        }),
        filter((user) => !!user),
        take(1),
        catchError((err) => {
          throw err;
        })
      )
      .subscribe(
        (_) => {
          if (!this.userTokenProccessInit) {
            this._initTokenProccess(token);
            this.userTokenProccessInit = true;
          } else {
            this.currentStatus = Flattening.Status.ERROR;
          }
        },

        (_) => (this.currentStatus = Flattening.Status.ERROR)
      );
  }

  private _initTokenVideo(token: string) {
    this._persoItemService
      .getSharedPersoItem(token)
      .pipe(
        takeUntil(this.destroy$),
        catchError((err) => {
          throw err;
        })
      )
      .subscribe(
        (sharedPerso: AppSharedPersoItem) => {
          if (sharedPerso) {
          }
        },
        (_) => (this.currentStatus = Flattening.Status.ERROR)
      );
  }

  private _initUserVideo(id: string) {
    this.currentStatus = Flattening.Status.IN_PROGRESS;
    this._store
      .pipe(
        select(UserState.selectCurrent),
        switchMap((user) => {
          if (user) {
            return this._persoItemService.getPersoById(+id);
          } else {
            return of(null);
          }
        })
      )
      .subscribe(
        (persoItem: AppPersoItem) => {
          if (persoItem) {
            this.myVideo = persoItem;
            this._setUserVideo(persoItem);
          }
        },
        (_) => {
          this.currentStatus = Flattening.Status.ERROR;
        }
      );
  }

  private _setUserVideo(persoItem: AppPersoItem) {
    this.myVideo = persoItem;
    this.currentStatus = persoItem?.streamingFlattening?.status;
    if (this.currentStatus === undefined) {
      this._startFlattening(FlatteningType.STREAMING, persoItem);
      return;
    }
    if (this.currentStatus === Flattening.Status.IN_PROGRESS) {
      this._subscribeToPusher(persoItem.id);
    } else if (this.currentStatus === Flattening.Status.COMPLETED) {
      this.isVideoOwner = true;
      this.isMyVideoReady.next(true);
      this.isMyVideoReady.complete();
      if (this.myVideo.type === PersoItem.Type.MULTI_VIDEO) {
        this.mv.multiVideoAssets =
          persoItem.streamingFlattening.multiVideoAssets;
        this.mv.multiVideo = persoItem?.multiVideo;

        this.multiVideoStatusChange.next({
          videoPlayerStatus: MultiVideoPlayStatus.INTRO_START,
        });
      } else if (this.myVideo.type === PersoItem.Type.MULTI_DEVICE) {
        this.multiDeviceUrls = persoItem?.streamingFlattening.assets;
        this._startCallProccess(persoItem);
      } else {
        this.persoItemMainUrl = persoItem.streamingFlattening.asset;
        this.persoItemThumbUrl = persoItem.thumbnailUrlFragment.path;
      }
    }
  }

  private _setVisitorVideo() {
    this.currentStatus = this.sharedPersoItem?.flattening?.status;
    if (this.currentStatus === undefined) {
      this._startSharedFlattening(this.persoItemToken);
      return;
    }
    if (this.currentStatus === Flattening.Status.IN_PROGRESS) {
      this._subscribeToPusher(this.sharedPersoItem.persoItemId);
    } else if (this.currentStatus === Flattening.Status.COMPLETED) {
      this.persoItemMainUrl = this.sharedPersoItem.flattening.asset;
      this.persoItemThumbUrl = this.sharedPersoItem.thumbnailUrlFragment.path;
      if (this.vgApi) {
        this.vgApi.play();
      }
    }
  }

  private isOwner(id: number): Observable<boolean> {
    return new Observable<boolean>((observer) => {
      this._persoItemService
        .getPersoById(id)
        .pipe(take(1))
        .subscribe(
          (persoItem) => {
            if (persoItem) {
              this.myVideo = persoItem;
              observer.next(true);
            } else {
              observer.next(false);
            }
            observer.complete();
          },
          (_) => {
            observer.next(false);
            observer.complete();
          }
        );
    });
  }

  private _initMeta() {
    this.webHelper
      .getContentPage("player")
      .pipe(takeUntil(this.destroy$))
      .subscribe((_page) => {
        const page = _page;
        this._metaTagsService.noIndexPage("noindex, nofollow");
        this._metaTagsService.updateSeoTags(page);
      });
  }

  private _handleKidPlayer() {
    this.isKidPlayer$.pipe(takeUntil(this.destroy$)).subscribe((isKid) => {
      if (!isKid) {
        this.route.queryParams
          .pipe(takeUntil(this.destroy$))
          .subscribe((queryParams) => {
            if (queryParams && !queryParams.internal) {
              // this._infoMessages.init();
            }
          });
      }
    });
  }

  private initMultiVideoProccess() {
    this.multiVideoStatusChange$
      .pipe(delay(100), takeUntil(this.destroy$))
      .subscribe((multiVideoPlay: MultiVideoPlay) => {
        const introVideo = this._document.getElementById(
          "intro-video"
        ) as HTMLVideoElement;
        const choicesVideo = this._document.getElementById(
          "choices-video"
        ) as HTMLVideoElement;
        const outroVideo = this._document.getElementById(
          "outro-video"
        ) as HTMLVideoElement;
        let selectedZone: HTMLVideoElement;

        if (!isNaN(multiVideoPlay.zoneIndex)) {
          selectedZone = this._document.getElementById(
            `zone-video-${multiVideoPlay.zoneIndex}`
          ) as HTMLVideoElement;
        } else {
          const zones: {
            [index: number]: HTMLVideoElement;
          } = {};
          this.mv.multiVideo.clickZonesList.forEach((zone, i) => {
            zones[i] = this._document.getElementById(
              `zone-video-${i}`
            ) as HTMLVideoElement;
          });
          multiVideoPlay.zoneIndex = Math.floor(
            Math.random() * this.mv.multiVideo.clickZonesList.length
          );
          selectedZone = zones[multiVideoPlay.zoneIndex];
        }

        switch (multiVideoPlay.videoPlayerStatus) {
          case MultiVideoPlayStatus.INTRO_START:
            introVideo.hidden = false;
            introVideo.play();
            this.viewIncrementLog();
            introVideo.addEventListener("ended", (_) => {
              this.showOverlayPlay = false;
              this.showZones = true;
              this.multiVideoStatusChange.next({
                videoPlayerStatus: MultiVideoPlayStatus.CHOSES_START,
              });
            });

            break;
          case MultiVideoPlayStatus.CHOSES_START:
            introVideo.pause();
            introVideo.hidden = true;
            choicesVideo.hidden = false;
            choicesVideo.play();
            choicesVideo.addEventListener("ended", (_) => {
              this.showZones = false;
              this.multiVideoStatusChange.next({
                videoPlayerStatus: MultiVideoPlayStatus.ZONE_START,
              });
            });
            break;
          case MultiVideoPlayStatus.ZONE_START:
            choicesVideo.pause();
            choicesVideo.hidden = true;
            selectedZone.hidden = false;
            selectedZone.play();
            selectedZone.addEventListener("ended", (_) => {
              this.multiVideoStatusChange.next({
                zoneIndex: multiVideoPlay.zoneIndex,
                videoPlayerStatus: MultiVideoPlayStatus.OUTRO_START,
              });
            });
            break;

          case MultiVideoPlayStatus.OUTRO_START:
            selectedZone.pause();
            selectedZone.hidden = true;
            outroVideo.hidden = false;
            outroVideo.play();
        }
      });
  }

  private _startCallProccess(persoItem: AppPersoItem) {
    this._store.dispatch(
      new ModalActions.OpenAction({
        cmpType: PlaceCallModalComponent,
        props: {
          trackTitle: "Place VU call",
          type: PlaceModalType.VU_CALL,
          item: persoItem,
          placeCallStarted: (phoneNumber: AppPhoneNumber) => {
            this.startVideo = this._document.getElementById(
              "start-elem"
            ) as HTMLVideoElement;
            this.answeredVideo = this._document.getElementById(
              "answered-elem"
            ) as HTMLVideoElement;
            this.incompleteVideo = this._document.getElementById(
              "incomplete-elem"
            ) as HTMLVideoElement;

            this.startVideo.hidden = false;
            const playPromise = this.startVideo.play();
            const playCb = () => {
              this._win.setTimeout(() => {
                this._createCall(phoneNumber);
              }, persoItem?.multiDevice?.config?.initiateCallAt?.seconds * 1000);
            };
            if (playPromise) {
              playPromise.then(playCb);
            } else {
              this.startVideo.addEventListener("play", playCb);
            }
          },
        },
        modalOptions: {
          backdrop: "static",
          size: "md",
        },
      })
    );
  }

  private _createCall(phoneNumber: AppPhoneNumber) {
    this._phoneCallService
      .createPhoneCall(this.myVideo.id, phoneNumber)
      .subscribe((_) => {
        this._subscribeToVUPusher();
      });
  }

  private _vuAnswered() {
    this.startVideo.muted = true;
    const playPromise = this.answeredVideo.play();
    const playCb = () => {
      this.answeredVideo.hidden = false;
      this.startVideo.pause();
      this.startVideo.hidden = true;
    };
    if (playPromise) {
      playPromise.then(playCb);
    } else {
      this.answeredVideo.addEventListener("play", playCb);
    }
  }

  private _vuCompleted() {
    if (
      this.answeredVideo.currentTime <
      this.myVideo?.multiDevice?.config?.callIncompleteBefore?.seconds
    ) {
      const playPromise = this.incompleteVideo.play();
      const playCb = () => {
        this.incompleteVideo.hidden = false;
        this.answeredVideo.hidden = true;
        this.answeredVideo.pause();
      };
      if (playPromise) {
        playPromise.then(playCb);
      } else {
        this.incompleteVideo.addEventListener("play", playCb);
      }
    } else {
      this.answeredVideo.muted = false;
    }
  }

  private _startSharedFlattening(token) {
    this.currentStatus = Flattening.Status.IN_PROGRESS;

    this._persoItemService
      .flattenPersoItemByToken(token)
      .pipe(takeUntil(this.destroy$))
      .subscribe((sharedItem) => {
        this.currentStatus = sharedItem?.flattening?.status;
        if (this.currentStatus === Flattening.Status.IN_PROGRESS) {
          this._subscribeToPusher(sharedItem.persoItemId);
        } else if (this.currentStatus === Flattening.Status.COMPLETED) {
          this.persoItemMainUrl = sharedItem?.flattening?.asset;
          this.persoItemThumbUrl = sharedItem?.thumbnailUrlFragment?.path;
          this.isMyVideoReady.next(true);
          this.isMyVideoReady.complete();
        } else {
          this.currentStatus = Flattening.Status.ERROR;
        }
      });
  }

  private _startFlattening(type: FlatteningType, persoItem: AppPersoItem) {
    this.currentStatus = Flattening.Status.IN_PROGRESS;
    this._persoItemService
      .flattenPersoItem(persoItem.id, type)
      .pipe(takeUntil(this.destroy$))
      .subscribe((faltteningResponse: FlattenPersoItemResponse.AsObject) => {
        this.currentStatus = faltteningResponse?.flattening?.status;
        if (this.currentStatus === Flattening.Status.IN_PROGRESS) {
          this._subscribeToPusher(faltteningResponse.persoItemId);
        } else if (this.currentStatus === Flattening.Status.COMPLETED) {
          if (faltteningResponse?.flattening?.assets) {
            if (this.myVideo.type === PersoItem.Type.MULTI_VIDEO) {
              this.mv.multiVideoAssets =
                faltteningResponse.flattening.multiVideoAssets;
              this.mv.multiVideo = this.myVideo.multiVideo;
              this.multiVideoStatusChange.next({
                videoPlayerStatus: MultiVideoPlayStatus.INTRO_START,
              });
            } else if (this.myVideo.type === PersoItem.Type.MULTI_DEVICE) {
              this.multiDeviceUrls = faltteningResponse.flattening.assets;
              this._startCallProccess(persoItem);
            }
          } else {
            this.persoItemMainUrl = faltteningResponse?.flattening?.asset;
          }
          this.persoItemThumbUrl = this.myVideo.thumbnailUrlFragment.path;
          this.isVideoOwner = true;
          this.isMyVideoReady.next(true);
          this.isMyVideoReady.complete();
        } else {
          this.currentStatus = Flattening.Status.ERROR;
        }
      });
  }

  private _subscribeToPusher(id: number) {
    this._pusherService.subscribeToChannel(
      id,
      PusherEvents.FLATTENING_STATUS_UPDATE,
      (persoId, status) => {
        if (this.sharedPersoItem.persoItemId === persoId) {
          this.currentStatus = Flattening.Status[status];
          if (this.currentStatus === Flattening.Status.COMPLETED) {
            if (this.persoItemToken) {
              this._win.setTimeout(() => {
                this._initTokenVideo(this.persoItemToken);
              }, 200);
            } else {
              this._store.dispatch(
                new PersoItemActions.FetchByIdAction({
                  id: persoId,
                })
              );
            }
          }
        }
      }
    );
  }

  private _subscribeToVUPusher() {
    this._pusherService.subscribeToVuChannel(
      this.myVideo.id,
      PusherEvents.VU_STATUS_UPDATE,
      () => this._vuAnswered(),
      () => this._vuCompleted()
    );
  }
  private viewIncrementLog() {
    this._persoItemService
      .incrementView(this.videoId)
      .pipe(takeUntil(this.destroy$))
      .subscribe(console.log);
  }
}
