import { OnInit, Directive } from '@angular/core';
import { select, Store } from '@ngrx/store';
import { FirstName } from '@pnp/api';
import { AppConfig, CatalogState } from '@pnp/features/catalog';
import { ProgressService, WindowService } from '@pnp/features/shared/services';
import { ModalActions } from '@pnp/features/ui/state/modal.action';
import { copyFormControl } from '@pnp/utils';
import { BehaviorSubject, of } from 'rxjs';
import { catchError, takeUntil } from 'rxjs/operators';
import { IRecorderResponse, PronunciationModalResponse } from '../../../models';
import { FormService } from '../../../services';
import { FormActions } from '../../../state';
import { FormFirstNameAudioBaseComponent } from './form-first-name-audio.base-component';

@Directive()
export abstract class PronunciationModalBaseComponent extends FormFirstNameAudioBaseComponent implements OnInit {
  nameRequestEnabled: boolean;
  isShowRecorder = false;
  name: string;
  confirmAudio = false;
  // since name is bound, always keep reference to name user started with when modal was opened
  private _origName: string;
  private pendingRequest = false;

  protected constructor(
    store: Store<any>,
    formService: FormService,
    protected win: WindowService,
    protected progress: ProgressService
  ) {
    super(store);
    // populate super class via it's Input
    this.formService = formService;
  }

  private _recordingSubmitted$: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);
  get recordingSubmitted$() {
    return this._recordingSubmitted$;
  }

  get recordingSubmitted() {
    return this._recordingSubmitted$.getValue();
  }

  set recordingSubmitted(value: boolean) {
    this._recordingSubmitted$.next(value);
  }

  ngOnInit() {
    this.isOptionsModal = true;
    this._initConfigs();
    if (this.group) {
      // clone group so it doesn't affect original group on the page
      this.group = copyFormControl(this.group);
      if (this.group?.value) {
        const name = this.group.value[this.config.searchInputQuestion];
        this._origName = this.name = name;
      }
    }
    super.ngOnInit();
    this.nameChosen$.pipe(takeUntil(this.destroy$)).subscribe(({ inputName, firstName }) => {
      if (this.config.name === inputName) {
        this.setSelectedName(firstName);
        this.setAudioUrl(firstName);
        /**
         * As soon as new name is selected change back
         * to the "Request Pronunciation" button module.
         */
        if (this.recordingSubmitted) {
          this.recordingSubmitted = false;
        }
      }
    });
  }

  togglePlay(...args) {
    super.togglePlay(...args);
  }

  handleRecorded(recording: IRecorderResponse) {
    if (!this.pendingRequest) {
      this.pendingRequest = true;
      this.progress.toggleSpinner(true);
      this.formService
        .submitSuggestedName(recording.firstName, recording.audioUrl)
        .pipe(
          catchError(err => {
            return of(null);
          })
        )
        .subscribe(res => {
          this.pendingRequest = false;
          this.progress.toggleSpinner();
          if (res) {
            this.toggleRecorder(false);
            this.recordingSubmitted = true;
          } else {
            this.win.alert('An error occurred.');
          }
        });
    }
  }

  toggleRecorder(status?: boolean) {
    if (typeof status === 'undefined') {
      this.isShowRecorder = !this.isShowRecorder;
    } else {
      this.isShowRecorder = status;
    }
  }

  search(name?: string) {
    // reset when users searches to retain standard behavior
    this.optionsModalStartName = null;
    this.store.dispatch(
      new FormActions.GetFirstNamesAction({
        name: name || this.name,
        fieldName: this.config.searchInputQuestion
      })
    );
  }

  saveCode(firstName: FirstName) {
    // save specific pronunciation
    this.selectedCode = firstName.code;
    return this.save(firstName);
  }

  save(firstName?: FirstName) {
    const customPronunciation = this.name || null;
    const fieldName = this.config.name;
    const groupUpdates: any = {};
    groupUpdates[fieldName] = this.selectedCode;
    this.formService.setCustomPronunciations(groupUpdates);
    let value: any = {
      groupUpdates,
      fieldName,
      customPronunciation
    };

    return this.close(value);
  }

  close(value?: PronunciationModalResponse) {
    if (!value) {
      value = {
        closed: true
      };
      // reset form state back to where it started
      const firstNamesActiveFieldNames = {};
      firstNamesActiveFieldNames[this.config.searchInputQuestion] = this._origName;
      this.store.dispatch(
        new FormActions.ChangedAction({
          firstNamesFetching: false,
          firstNameLatest: this._origName,
          firstNamesActiveFieldNames
        })
      );
    } else {
      this.store.dispatch(
        new FormActions.ChangedAction({
          firstNameLatest: this._origName
        })
      );
    }

    this.store.dispatch(
      new ModalActions.CloseAction({
        value
      })
    );

    return value;
  }

  protected _initConfigs() {
    this.store.pipe(select(CatalogState.selectConfig), takeUntil(this.destroy$)).subscribe((appConfig: AppConfig) => {
      this.nameRequestEnabled = appConfig.enableNameSuggestion;
    });
  }
}
