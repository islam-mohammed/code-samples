import { Directive, Input, OnDestroy, OnInit } from "@angular/core";
import { select, Store } from "@ngrx/store";
import { FirstName, UserRecipient } from "@pnp/api";
import { AudioActions, AudioState } from "@pnp/features/audio";

import { ModalActions } from "@pnp/features/ui/state/modal.action";
import { ModalState } from "@pnp/features/ui/state/modal.state";
import { UIState } from "@pnp/features/ui/state/ui.state";
import { UserState } from "@pnp/features/user";
import { BehaviorSubject, Observable, Subject, Subscription } from "rxjs";
import {
  debounceTime,
  distinctUntilChanged,
  map,
  take,
  takeUntil,
  withLatestFrom,
} from "rxjs/operators";
import { IValidateTargetUpdate } from "../../../services";
import { FormActions, FormState } from "../../../state";
import {
  FormSelectBaseComponent,
  ISelectItem,
} from "../form-select/form-select.base-component";
import { TokenString } from "src/app/xplat/core/services/token-string";

/**
 * Form firstNameAudio abstraction.
 * This should be extended in web and mobile with platform specific templates
 */
@Directive()
export abstract class FormFirstNameAudioBaseComponent
  extends FormSelectBaseComponent
  implements OnInit, OnDestroy {
  @Input()
  selectedFirstNameId: string;
  firstNames$: BehaviorSubject<Array<FirstName>> = new BehaviorSubject([]);
  nameChosen$: Subject<{
    inputName: string;
    firstName: FirstName;
  }> = new Subject();
  selectedName: FirstName;
  audioAvailable = false;
  refreshAvailable = false;
  isExactMatch = false;
  exactMatches: Array<FirstName>;
  inputName: string;
  openedOptionsModal = false; // helps controls in page
  isOptionsModal = false; // helps controls in modal
  optionsModalStartName: FirstName; // force a selection in modal right when opens

  fetching$: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);
  private _internalNames: Array<FirstName>;
  private _audioUrl: string;

  private _modalSub: Subscription;
  private _pronunciationLabel: string;
  private _customChoiceSub: Subscription;

  private showUpsellModal: Subject<any> = new Subject<any>();
  public showUpsellModal$ = this.showUpsellModal.asObservable();

  protected constructor(store: Store<FormState.IFeatureState>) {
    super(store);
  }

  private _fetching = false;
  get fetching() {
    return this._fetching;
  }

  set fetching(value: boolean) {
    this._fetching = value;
    this.fetching$.next(value);
  }

  // helps coordinate selections against when results are available
  private _selectedCode: string;
  get selectedCode() {
    return this._selectedCode;
  }

  set selectedCode(value: string) {
    this._selectedCode = value;
    const currentFirstNames = this.firstNames$.getValue();
    if (currentFirstNames?.length) {
      // only if there are results to find a match
      // console.log('EMITING SELECTION CHANGE', this.config, currentFirstNames);
      this._emitSelectionChange(currentFirstNames);
    }
  }

  private _nicknameLabel: string;
  get nicknameLabel() {
    return this._nicknameLabel;
  }
  ngOnInit() {
    const name = this.group.get("toFirstName")?.value;
    if (name) {
      this.store.dispatch(
        new FormActions.GetFirstNamesAction({
          name,
          fieldName: this.config.name,
        })
      );
    }

    this._pronunciationLabel = TokenString.Pronunciation.FORM_LBL;
    this._nicknameLabel = TokenString.Pronunciation.NICKNAMES_LBL;
    if (this.config?.placeholder) {
      this.selectedName = {
        name: this.config.placeholder,
      };
    }

    this.formService.validateTargetUpdate$
      .pipe(takeUntil(this.destroy$))
      .subscribe((update: IValidateTargetUpdate) => {
        if (
          (update.name === this.config.name ||
            this.config.searchInputQuestion === update.name) &&
          (update.hasOwnProperty("checked") ||
            update.hasOwnProperty("value") ||
            update.hasOwnProperty("targetValues"))
        ) {
          let hidden = true;
          if (update.targetValues?.length) {
            hidden = !update.targetValues.includes(update.value);
          } else if (update.hasOwnProperty("checked")) {
            hidden = !parseInt(update.checked as any);
          } else {
            hidden = update.value !== this.config.value;
          }
          if (hidden) {
            this.clearValidators(true);
          } else if (
            ["requiredIfNotEmpty", "requiredIfValue"].includes(update.type)
          ) {
            this.config.hidden = false;
            this.setRequired();
          }
        }
      });

    const user$: Observable<any> = this.store.pipe(
      select(UserState.selectState),
      take(1)
    );
    const form$: Observable<any> = this.store.pipe(
      select(FormState.selectState),
      take(1)
    );

    this.group.valueChanges
      .pipe(
        withLatestFrom(user$, form$),
        map(([value, user, form]) => {
          return {
            name: value[this.config.name],
            userState: user,
            formState: form,
          };
        }),
        distinctUntilChanged(),
        debounceTime(500),
        takeUntil(this.destroy$)
      )
      .subscribe((value) => {
        if (value.name) {
          this.selectedCode = value.name;
        }
      });

    this.store
      .pipe(select(FormState.selectState), takeUntil(this.destroy$))
      .subscribe((forms: FormState.IState) => {
        const customChoice = this.isOptionsModal
          ? null
          : this.formService.customPronunciations[this.config.name];
        const isInitializing = this.firstNames$.getValue().length === 0;
        if (
          !this.openedOptionsModal &&
          forms.firstNamesActiveFieldNames &&
          (!customChoice || isInitializing)
        ) {
          const activeName =
            forms.firstNamesActiveFieldNames[this.config.searchInputQuestion];
          // only handle list for the currently searched name (forms.firstNameLatest)
          if (forms.firstNameLatest === activeName) {
            this.inputName = activeName;
            const selectedRecipient: UserRecipient = forms.selectedRecipient;
            let toFirstNameId = null;
            if (
              isInitializing &&
              !this.isOptionsModal &&
              this.config.searchInputQuestion === "toFirstName" &&
              selectedRecipient
            ) {
              // always ignore when working within options modal
              // only should be done when working with toFirstName field which deals directly with selectedRecipient only
              toFirstNameId =
                selectedRecipient.dataMap?.toFirstNameId ||
                selectedRecipient[`toFirstNameId`];
            } else if (customChoice) {
              toFirstNameId = customChoice;
            }
            if (activeName) {
              // update fetching state
              this.fetching = forms.firstNamesFetching;
              if (
                forms.firstNames &&
                Array.isArray(forms.firstNames[activeName])
              ) {
                // ensure immutability
                const firstNames = forms.firstNames[activeName];
                this._updateNameList(firstNames, toFirstNameId);
                this._internalNames = firstNames;
              }
            }
          }
        }
      });
    this.firstNames$
      .pipe(takeUntil(this.destroy$))
      .subscribe((names: Array<FirstName>) => {
        if (!this.openedOptionsModal) {
          if (names?.length) {
            if (this.isOptionsModal) {
              // used to display only exact matches (clone)
              this.exactMatches = [...names.filter((n) => n.isExactMatch)].map(
                (n) => {
                  return {
                    ...n,
                  };
                }
              );
              if (this.exactMatches?.length > 1) {
                // label appropriately
                let cnt = 1;
                this.exactMatches.forEach((n) => {
                  n.name = `${this._pronunciationLabel} ${cnt}`;
                  cnt++;
                });
              }
              // in options modal, the reset of the names are close match/nicknames
              names = names.filter((n) => !n.isExactMatch);
            }
            this.selectGroups = [];
            names.forEach((n) => {
              let group = this.selectGroups.find(
                (_group) => _group.name === n.group
              );
              if (!group) {
                group = {
                  name: n.group,
                  items: [],
                };
                this.selectGroups.push(group);
              }
              group.items.push({
                name: n.name,
                value: n.code,
                isExactMatch: n.isExactMatch,
              });
            });
            const control = this.group.get(this.config.name);
            control.enable();
            if (control.value) {
              // useful when navigating back to form page with this field
              this.setAudioUrl(names.find((n) => n.code === control.value));
            }
          } else {
            this.group.get(this.config.name).disable();
          }
        }
      });
    this.nameChosen$
      .pipe(takeUntil(this.destroy$))
      .subscribe(({ inputName, firstName }) => {
        if (!this.openedOptionsModal && this.config.name === inputName) {
          this.showUpsellModal.next(true);
          this.setSelectedName(firstName);
          this.setAudioUrl(firstName);
        }
      });
  }

  setSelectedName(firstName: FirstName) {
    if (firstName) {
      this.selectedName = firstName;
    }
  }

  customChoice() {
    this._resetCustom();
    this._customChoiceSub = this.group.valueChanges
      .pipe(map((value) => value[this.config.name]))
      .subscribe((value: string) => {
        if (value !== this.selectedCode) {
          const custom = {};
          custom[this.config.name] = value;
          this.formService.setCustomPronunciations(custom);
        }
        this._resetCustom();
      });
  }

  /**
   * When formControlName binding is not available, implementors can use this
   * See NativeScript app for example of how this is used
   */
  selectName(item: ISelectItem) {
    this.selectedName = this._internalNames.find(
      (n) => n.code === item.value && n.name === item.name
    );
    this.updateValue(this.selectedName.code);
  }

  togglePlay(forceUrl?: string) {
    const url = forceUrl || this._audioUrl;
    if (url) {
      this.store
        .pipe(select(AudioState.selectUrl), take(1))
        .subscribe((audioStateUrl: string) => {
          // if currently loaded is different, force playback
          const options: AudioActions.ITogglePlayOptions = {
            mediaId: "",
            url,
          };
          if (audioStateUrl !== options.url) {
            options.forcePlayingState = true;
          }
          this.store.dispatch(new AudioActions.TogglePlayAction(options));
        });
    }
  }

  refreshNames() {
    this._updateNameList(this._internalNames);
    this.refreshAvailable = false;
  }

  setAudioUrl(firstName: FirstName) {
    if (firstName) {
      if (firstName.assetUrl) {
        if (this._audioUrl !== firstName.assetUrl) {
          this._audioUrl = firstName.assetUrl;
          this.audioAvailable = true;
        }
      } else {
        this.audioAvailable = false;
      }
    }
  }

  handlePronunciationModal() {
    this.openedOptionsModal = true;
    this._resetModal();
    this._modalSub = this.store
      .pipe(select(UIState.selectModal))
      .subscribe((state: ModalState.IState) => {
        if (state && !state.open) {
          this.handleModalResult(state.latestResult);
        }
      });
  }

  handleModalResult(result: any) {
    if (result?.value) {
      this.openedOptionsModal = false;
      const updates = result.value.groupUpdates;
      const fieldName = result.value.fieldName;
      // if special pronunciation choice
      const customPronunciation = result.value.customPronunciation;
      if (updates) {
        // closed with changes
        this.group.patchValue(updates, {
          emitEvent: true,
        });
        if (updates[fieldName]) {
          const searchName = customPronunciation || this.selectedName.name;
          // update widget
          this.store
            .pipe(select(FormState.selectFirstNames), take(1))
            .subscribe((firstNames: FormState.IFirstNames) => {
              this._updateNameList(
                firstNames[searchName],
                updates[fieldName],
                true
              );
            });
        }
      }
      this._resetModal(true);
    }
  }

  ngOnDestroy() {
    super.ngOnDestroy();
    this._resetModal(true);
    // reset
    this.formService.resetActiveFirstNames();
    this.store.dispatch(new AudioActions.StopAction());
  }

  private _resetCustom() {
    if (this._customChoiceSub) {
      this._customChoiceSub.unsubscribe();
      this._customChoiceSub = null;
    }
  }

  private _emitSelectionChange(firstNames: FirstName[]) {
    if (firstNames.length && this._selectedCode) {
      const firstName = firstNames.find((n) => n.code === this._selectedCode);
      if (firstName) {
        this.nameChosen$.next({
          inputName: this.config.name,
          firstName,
        });
      }
    }
  }

  private _updateNameList(
    firstNames: Array<FirstName>,
    forceCode: string = null,
    ignoreExact = false
  ) {
    if (firstNames?.length) {
      // default to first result
      let firstName: FirstName = firstNames[0];
      // if coming from a modal, code passed in via @Input() selectedFirstNameId
      if (forceCode || this.selectedFirstNameId) {
        const code = forceCode || this.selectedFirstNameId;
        const firstNameCodeMatch = firstNames.filter(
          (name) => name.code === code
        );
        if (firstNameCodeMatch?.length) {
          ignoreExact = true; // force this name selection
          firstName = firstNameCodeMatch[0];
        }
        // Clear refreshNamesClicked, it's only needed/used when the modal is first opened
        this.selectedFirstNameId = null;
      }
      const closeMatchLabel = TokenString.Pronunciation.SELCT_MATCH_LBL;
      // new names (immutable - brand new list - in case Push change detection is used eventually)
      this.firstNames$.next([...firstNames]);
      // for now, just update based on first result
      if (firstName) {
        // update form since this is an exact match
        this.isExactMatch = firstName.isExactMatch;
        if (
          this.isExactMatch ||
          ignoreExact ||
          (this.isOptionsModal && this.optionsModalStartName)
        ) {
          if (this.optionsModalStartName) {
            // force override for modal options
            firstName = this.optionsModalStartName;
          }
          // either an exact match or...
          // explicitly ignoring exact and force setting value
          // ie: pronunciation modal
          this.updateValue(firstName.code);
          this.selectedCode = firstName.code;
          if (this.isOptionsModal) {
            this.selectedName = {
              name: this.isExactMatch ? this._nicknameLabel : closeMatchLabel,
            };
          } else {
            this.selectedName = firstName;
          }
          this.setAudioUrl(this.selectedName);
        } else {
          // clear when no exact match
          // user has options at this point as to what to do
          this.updateValue(null);
          this.selectedCode = null;
          this.selectedName = {
            name: closeMatchLabel,
          };
          this.audioAvailable = false;
        }
      } else {
        this.isExactMatch = false;
      }
    } else {
      this.isExactMatch = false;
    }
  }

  private _resetModal(resetState?: boolean) {
    if (this._modalSub) {
      this._modalSub.unsubscribe();
      this._modalSub = null;
    }
    if (resetState) {
      // reset result
      this.store.dispatch(
        new ModalActions.ClosedAction({
          open: false,
          latestResult: null,
        })
      );
    }
  }
}
